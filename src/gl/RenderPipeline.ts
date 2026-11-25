/**
 * 渲染管线：拥有全部 GPU 资源，按帧调度
 * 合成 -> 雨线检测/时序验证/修补 -> 水珠检测/累积/修补 -> 光晕压制/锐化 -> 指标
 */
import { GLContext, Program, Texture2D, Framebuffer, RingBuffer, AsyncReadback } from './glUtils';
import { SCENE_FRAG } from './shaders/scene';
import { DEGRADE_FRAG, PLATE_MASK_FRAG } from './shaders/degrade';
import {
  RAIN_FEATURES_FRAG,
  RAIN_TEMPORAL_FRAG,
  RAIN_INPAINT_FRAG,
} from './shaders/rain';
import {
  DROPLET_FEATURES_FRAG,
  DROPLET_ACCUM_FRAG,
  DROPLET_UPSAMPLE_FRAG,
  DROPLET_INPAINT_FRAG,
} from './shaders/droplet';
import { FINALIZE_FRAG, SSE_FRAG, REDUCE_FRAG, DOWNSAMPLE_FRAG, COPY_FRAG } from './shaders/finalize';
import { PipelineParams, DropletMark } from '../types';
import { buildFontAtlas, CELL_W, CELL_H } from './font';

const HISTORY = 7;

function rgba16f(gl: WebGL2RenderingContext, mip = false): Texture2D {
  return new Texture2D(gl, { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, mipmaps: mip });
}
function r32f(gl: WebGL2RenderingContext): Texture2D {
  return new Texture2D(gl, { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, mipmaps: false, filter: gl.NEAREST });
}

export class RenderPipeline {
  readonly ctx: GLContext;
  private gl: WebGL2RenderingContext;
  width = 1920;
  height = 1080;
  halfW = 960;
  halfH = 540;

  private pScene!: Program;
  private pDegrade!: Program;
  private pPlateMask!: Program;
  private pRainFeat!: Program;
  private pRainTemp!: Program;
  private pRainInpaint!: Program;
  private pDropFeat!: Program;
  private pDropAccum!: Program;
  private pDropUp!: Program;
  private pDropInpaint!: Program;
  private pFinalize!: Program;
  private pSSE!: Program;
  private pReduce!: Program;
  private pDown!: Program;
  private pCopy!: Program;

  // 纹理
  private fontTex!: Texture2D;
  private texScene!: Texture2D;       // 晴天 GT
  private texInput!: Texture2D;       // 雨天输入（视频模式下外部上传）
  private texExternal!: Texture2D;    // 外部视频上传用
  private texRainFeat!: Texture2D;
  private rainHistTex!: Texture2D[];  // ping-pong 2
  private texRainMask!: Texture2D;
  private texRainOut!: Texture2D;
  private texHalf!: Texture2D;
  private texHalfPrev!: Texture2D;
  private texDropFeat!: Texture2D;
  private dropAccTex!: Texture2D[];   // ping-pong 2（半分辨率）
  private texDropHalfMask!: Texture2D;
  private texDropMask!: Texture2D;
  private texDropOut!: Texture2D;
  private texFinal!: Texture2D;
  private texSSEA!: Texture2D;
  private texSSEB!: Texture2D;
  private texPlateMask!: Texture2D;
  private fboScratch!: Framebuffer;

  private historyInput!: RingBuffer<Texture2D>;
  private historyHalf!: RingBuffer<Texture2D>;

  private readback: AsyncReadback;
  private marks: DropletMark[] = [];
  private frameCounter = 0;
  rainAngleRad = (12 * Math.PI) / 180;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = new GLContext(canvas);
    this.gl = this.ctx.gl;
    this.readback = new AsyncReadback(this.gl);
    this.initPrograms();
    this.initTextures();
  }

  private initPrograms(): void {
    this.pScene = this.ctx.createProgram(SCENE_FRAG);
    this.pDegrade = this.ctx.createProgram(DEGRADE_FRAG);
    this.pPlateMask = this.ctx.createProgram(PLATE_MASK_FRAG);
    this.pRainFeat = this.ctx.createProgram(RAIN_FEATURES_FRAG);
    this.pRainTemp = this.ctx.createProgram(RAIN_TEMPORAL_FRAG);
    this.pRainInpaint = this.ctx.createProgram(RAIN_INPAINT_FRAG);
    this.pDropFeat = this.ctx.createProgram(DROPLET_FEATURES_FRAG);
    this.pDropAccum = this.ctx.createProgram(DROPLET_ACCUM_FRAG);
    this.pDropUp = this.ctx.createProgram(DROPLET_UPSAMPLE_FRAG);
    this.pDropInpaint = this.ctx.createProgram(DROPLET_INPAINT_FRAG);
    this.pFinalize = this.ctx.createProgram(FINALIZE_FRAG);
    this.pSSE = this.ctx.createProgram(SSE_FRAG);
    this.pReduce = this.ctx.createProgram(REDUCE_FRAG);
    this.pDown = this.ctx.createProgram(DOWNSAMPLE_FRAG);
    this.pCopy = this.ctx.createProgram(COPY_FRAG);
  }

  private initTextures(): void {
    const gl = this.gl;
    const atlas = buildFontAtlas();
    this.fontTex = new Texture2D(gl, { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST });
    this.fontTex.upload(atlas);

    this.texScene = rgba16f(gl);
    this.texInput = rgba16f(gl);
    this.texExternal = rgba16f(gl);
    this.texRainFeat = rgba16f(gl);
    this.rainHistTex = [rgba16f(gl), rgba16f(gl)];
    this.texRainMask = rgba16f(gl);
    this.texRainOut = rgba16f(gl);
    this.texHalf = rgba16f(gl);
    this.texHalfPrev = rgba16f(gl);
    this.texDropFeat = rgba16f(gl);
    this.dropAccTex = [rgba16f(gl), rgba16f(gl)];
    this.texDropHalfMask = rgba16f(gl);
    this.texDropMask = rgba16f(gl);
    this.texDropOut = rgba16f(gl);
    this.texFinal = new Texture2D(gl); // RGBA8 显示/录制
    this.texSSEA = r32f(gl);
    this.texSSEB = r32f(gl);
    this.texPlateMask = new Texture2D(gl, { filter: gl.NEAREST });
    this.fboScratch = new Framebuffer(gl);

    this.historyInput = new RingBuffer(() => rgba16f(gl), HISTORY);
    this.historyHalf = new RingBuffer(() => rgba16f(gl), HISTORY);
    this.resize(1920, 1080);
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.halfW = Math.max(2, Math.floor(w / 2));
    this.halfH = Math.max(2, Math.floor(h / 2));
    const full = [
      this.texScene, this.texInput, this.texExternal, this.texRainFeat,
      ...this.rainHistTex, this.texRainMask, this.texRainOut,
      this.texDropMask, this.texDropOut, this.texFinal,
      this.texSSEA, this.texSSEB, this.texPlateMask,
    ];
    for (const t of full) t.resize(w, h);
    const half = [
      this.texHalf, this.texHalfPrev, this.texDropFeat,
      ...this.dropAccTex, this.texDropHalfMask,
    ];
    for (const t of half) t.resize(this.halfW, this.halfH);
    for (const t of this.historyInput.all()) t.resize(w, h);
    for (const t of this.historyHalf.all()) t.resize(this.halfW, this.halfH);
    this.resetTemporal();
  }

  /** 切换视频源/参数剧变时清空时序累积，避免鬼影。 */
  resetTemporal(): void {
    const gl = this.gl;
    const clearTex = (t: Texture2D, w: number, h: number): void => {
      this.fboScratch.bind(w, h);
      this.fboScratch.attachColor(t);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    for (const t of this.rainHistTex) clearTex(t, this.width, this.height);
    for (const t of this.dropAccTex) clearTex(t, this.halfW, this.halfH);
    for (const t of this.historyInput.all()) clearTex(t, this.width, this.height);
    for (const t of this.historyHalf.all()) clearTex(t, this.halfW, this.halfH);
    this.frameCounter = 0;
  }

  setMarks(marks: DropletMark[]): void {
    this.marks = marks.slice(0, 32);
  }

  private renderTo(tex: Texture2D, prog: Program, w: number, h: number): void {
    this.fboScratch.bind(w, h);
    this.fboScratch.attachColor(tex);
    this.fboScratch.check();
    prog.use();
    this.ctx.fullscreen();
  }

  /**
   * 合成模式：生成 GT 晴天帧 + 雨天退化帧。
   * 返回 GT 纹理（供指标对比）。
   */
  renderSynthetic(time: number, params: PipelineParams, seed: number): Texture2D {
    // 1) 晴天场景
    this.pScene.use();
    this.pScene.f1('uTime', time);
    this.pScene.f2('uResolution', this.width, this.height);
    this.pScene.tex('uFontTex', 0, this.fontTex.tex);
    this.pScene.f4('uFontInfo', 6, 6, CELL_W, CELL_H);
    this.renderTo(this.texScene, this.pScene, this.width, this.height);

    // 2) 雨天退化
    this.pDegrade.use();
    this.pDegrade.tex('uScene', 0, this.texScene.tex);
    this.pDegrade.f2('uResolution', this.width, this.height);
    this.pDegrade.f1('uTime', time);
    this.pDegrade.f1('uRain', params.rainIntensity);
    this.pDegrade.f1('uAngle', this.rainAngleRad);
    this.pDegrade.f1('uDroplets', params.dropletDensity);
    this.pDegrade.f1('uGlare', params.glareStrength);
    this.pDegrade.f1('uSeed', seed);
    this.renderTo(this.texInput, this.pDegrade, this.width, this.height);
    return this.texScene;
  }

  /** 外部视频/摄像头帧上传到输入纹理。 */
  uploadExternalFrame(frame: TexImageSource): void {
    this.texExternal.upload(frame);
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, this.texExternal.tex);
    this.pCopy.f2('uTexel', 1 / this.width, 1 / this.height);
    this.renderTo(this.texInput, this.pCopy, this.width, this.height);
  }

  /** 同 context 内纹理到纹理的拷贝（用于复用合成结果）。 */
  copyTexture(src: Texture2D, dst: Texture2D): void {
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, src.tex);
    this.pCopy.f2('uTexel', 1 / this.width, 1 / this.height);
    this.renderTo(dst, this.pCopy, this.width, this.height);
  }

  /**
   * 把指定纹理 blit 到 canvas 默认 framebuffer（屏幕呈现）。
   * mode: 0=最终结果 1=雨天输入 2=GT 3=水珠掩膜 4=雨线掩膜
   */
  present(mode: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 必须显式恢复全画布视口：PSNR 归约等 pass 会把视口改成 1x1
    gl.viewport(0, 0, this.width, this.height);
    this.pCopy.use();
    const tex =
      mode === 1 ? this.texInput :
      mode === 2 ? this.texScene :
      mode === 3 ? this.texDropMask :
      mode === 4 ? this.texRainMask :
      this.texFinal;
    this.pCopy.tex('uInput', 0, tex.tex);
    this.pCopy.f2('uTexel', 1 / this.width, 1 / this.height);
    this.ctx.fullscreen();
  }

  get inputTexture(): Texture2D {
    return this.texInput;
  }
  get finalTexture(): Texture2D {
    return this.texFinal;
  }
  get rainMaskTexture(): Texture2D {
    return this.texRainMask;
  }
  get dropMaskTexture(): Texture2D {
    return this.texDropMask;
  }
  get sceneTexture(): Texture2D {
    return this.texScene;
  }
  get plateMaskTexture(): Texture2D {
    return this.texPlateMask;
  }

  /**
   * 执行完整处理管线。frameTime 为合成时间（秒），用于车牌掩膜几何。
   */
  process(params: PipelineParams, frameTime: number, isSynthetic: boolean): void {
    const tx = 1 / this.width;
    const ty = 1 / this.height;
    const htx = 1 / this.halfW;
    const hty = 1 / this.halfH;

    // 时序环形缓冲先轮转，当前槽用于写入本帧
    const histSlot = this.historyInput.advance();
    const halfSlot = this.historyHalf.advance();

    // ---------- 雨线：特征 ----------
    this.pRainFeat.use();
    this.pRainFeat.tex('uInput', 0, this.texInput.tex);
    this.pRainFeat.f2('uTexel', tx, ty);
    this.pRainFeat.f1('uAngle', this.rainAngleRad);
    this.pRainFeat.f1('uThresh', params.rainCandidateThresh);
    this.pRainFeat.f1('uEdgeGuard', params.edgeGuardStrength);
    this.renderTo(this.texRainFeat, this.pRainFeat, this.width, this.height);

    // ---------- 雨线：时序验证（ping-pong） ----------
    const src = this.rainHistTex[0];
    const dst = this.rainHistTex[1];
    this.pRainTemp.use();
    this.pRainTemp.tex('uFeature', 0, this.texRainFeat.tex);
    this.pRainTemp.tex('uHistory', 1, src.tex);
    this.pRainTemp.f2('uTexel', tx, ty);
    this.pRainTemp.f1('uHold', 0.86);
    this.renderTo(dst, this.pRainTemp, this.width, this.height);
    this.rainHistTex.reverse();
    // 最新累积纹理即雨线掩膜
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, this.rainHistTex[0].tex);
    this.pCopy.f2('uTexel', tx, ty);
    this.renderTo(this.texRainMask, this.pCopy, this.width, this.height);

    // ---------- 雨线：时序中值修补 ----------
    this.pRainInpaint.use();
    this.pRainInpaint.tex('uCurrent', 0, this.texInput.tex);
    this.pRainInpaint.tex('uMask', 1, this.texRainMask.tex);
    const histAll = this.historyInput.all();
    for (let i = 0; i < HISTORY; i++) {
      this.pRainInpaint.tex(`uFrames${i}`, 2 + i, histAll[i].tex);
    }
    this.pRainInpaint.i1('uFrameCount', Math.min(this.frameCounter + 1, HISTORY));
    this.pRainInpaint.f2('uTexel', tx, ty);
    this.pRainInpaint.f1('uAngle', this.rainAngleRad);
    this.renderTo(this.texRainOut, this.pRainInpaint, this.width, this.height);

    // 本帧（去雨后）写入历史，供下帧中值使用
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, this.texRainOut.tex);
    this.pCopy.f2('uTexel', tx, ty);
    this.renderTo(histSlot, this.pCopy, this.width, this.height);

    // ---------- 水珠：半分辨率降采样 ----------
    this.pDown.use();
    this.pDown.tex('uInput', 0, this.texRainOut.tex);
    this.pDown.f2('uTexel', tx, ty);
    this.renderTo(this.texHalf, this.pDown, this.halfW, this.halfH);

    // ---------- 水珠：特征 ----------
    this.pDropFeat.use();
    this.pDropFeat.tex('uInput', 0, this.texHalf.tex);
    this.pDropFeat.tex('uPrev', 1, this.texHalfPrev.tex);
    this.pDropFeat.f2('uTexel', htx, hty);
    this.pDropFeat.f1('uSensitivity', params.dropletSensitivity);
    this.renderTo(this.texDropFeat, this.pDropFeat, this.halfW, this.halfH);

    // ---------- 水珠：证据累积 + 闭运算 ----------
    let dSrc = this.dropAccTex[0];
    let dDst = this.dropAccTex[1];
    const runAccum = (mode: number, hold: number): void => {
      this.pDropAccum.use();
      this.pDropAccum.tex('uFeature', 0, this.texDropFeat.tex);
      this.pDropAccum.tex('uEvidence', 1, dSrc.tex);
      this.pDropAccum.f2('uTexel', htx, hty);
      this.pDropAccum.f1('uHold', hold);
      this.pDropAccum.f1('uMode', mode);
      this.renderTo(dDst, this.pDropAccum, this.halfW, this.halfH);
      const tmp = dSrc;
      dSrc = dDst;
      dDst = tmp;
    };
    runAccum(0, params.dropletHold); // EMA 累积
    runAccum(1, params.dropletHold); // 膨胀
    runAccum(2, params.dropletHold); // 腐蚀
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, dSrc.tex);
    this.pCopy.f2('uTexel', htx, hty);
    this.renderTo(this.texDropHalfMask, this.pCopy, this.halfW, this.halfH);

    // ---------- 水珠：上采样到全分辨率 + 手动标注 ----------
    this.pDropUp.use();
    this.pDropUp.tex('uMaskHalf', 0, this.texDropHalfMask.tex);
    this.pDropUp.f2('uTexel', tx, ty);
    const markData = new Float32Array(32 * 4);
    for (let i = 0; i < 32; i++) {
      const m = this.marks[i];
      if (m) {
        markData[i * 4] = m.x;
        markData[i * 4 + 1] = m.y;
        markData[i * 4 + 2] = m.radius;
        markData[i * 4 + 3] = 1;
      } else {
        markData[i * 4 + 3] = 0;
      }
    }
    const loc = this.pDropUp.loc('uMarks[0]');
    if (loc) this.gl.uniform4fv(loc, markData);
    this.pDropUp.i1('uMarkCount', this.marks.length);
    this.renderTo(this.texDropMask, this.pDropUp, this.width, this.height);

    // ---------- 水珠：时序+空间修补 ----------
    this.pDropInpaint.use();
    this.pDropInpaint.tex('uCurrent', 0, this.texRainOut.tex);
    this.pDropInpaint.tex('uMask', 1, this.texDropMask.tex);
    // 静态水珠在所有历史帧同样存在，因此中值只做基础，空间修补在 shader 内兜底
    for (let i = 0; i < HISTORY; i++) {
      this.pDropInpaint.tex(`uFrames${i}`, 2 + i, histAll[i].tex);
    }
    this.pDropInpaint.i1('uFrameCount', Math.min(this.frameCounter + 1, HISTORY));
    this.pDropInpaint.f2('uTexel', tx, ty);
    this.renderTo(this.texDropOut, this.pDropInpaint, this.width, this.height);

    // ---------- 收尾：压光晕/去雾/锐化 ----------
    this.pFinalize.use();
    this.pFinalize.tex('uInput', 0, this.texDropOut.tex);
    this.pFinalize.tex('uRainMask', 1, this.texRainMask.tex);
    this.pFinalize.tex('uDropMask', 2, this.texDropMask.tex);
    this.pFinalize.f2('uTexel', tx, ty);
    this.pFinalize.f1('uGlare', params.glareStrength);
    this.pFinalize.f1('uShowMask', this.showMask ? 1 : 0);
    this.renderTo(this.texFinal, this.pFinalize, this.width, this.height);

    // 更新半分辨率历史
    this.pDown.use();
    this.pDown.tex('uInput', 0, this.texHalf.tex);
    this.pDown.f2('uTexel', htx, hty);
    this.renderTo(halfSlot, this.pDown, this.halfW, this.halfH);
    this.pCopy.use();
    this.pCopy.tex('uInput', 0, this.texHalf.tex);
    this.pCopy.f2('uTexel', htx, hty);
    this.renderTo(this.texHalfPrev, this.pCopy, this.halfW, this.halfH);

    // 合成模式下同步生成车牌几何掩膜（指标用）
    if (isSynthetic) {
      this.pPlateMask.use();
      this.pPlateMask.f1('uTime', frameTime);
      this.pPlateMask.f2('uResolution', this.width, this.height);
      this.renderTo(this.texPlateMask, this.pPlateMask, this.width, this.height);
    }
    this.frameCounter++;
  }

  showMask = false;

  /**
   * 计算图像与 GT 的 PSNR。
   * 第一级逐像素平方误差写 R32F，之后用 2x2 box 归约逐级减半到 1x1，
   * 只在最后回读单个浮点，不依赖浮点纹理的硬件 mipmap 能力。
   */
  computePSNR(image: Texture2D, gt: Texture2D): number {
    const gl = this.gl;
    // 第一级：全分辨率 SSE
    this.pSSE.use();
    this.pSSE.tex('uImg', 0, image.tex);
    this.pSSE.tex('uGT', 1, gt.tex);
    this.pSSE.f2('uTexel', 1 / this.width, 1 / this.height);
    this.renderTo(this.texSSEA, this.pSSE, this.width, this.height);

    // 逐级归约
    let src = this.texSSEA;
    let dst = this.texSSEB;
    let w = this.width;
    let h = this.height;
    this.pReduce.use();
    while (w > 1 || h > 1) {
      const nw = Math.max(1, Math.floor(w / 2));
      const nh = Math.max(1, Math.floor(h / 2));
      this.pReduce.tex('uInput', 0, src.tex);
      this.pReduce.f2('uSrcTexel', 1 / w, 1 / h);
      this.renderTo(dst, this.pReduce, nw, nh);
      const tmp = src;
      src = dst;
      dst = tmp;
      w = nw;
      h = nh;
    }
    const buf = new Float32Array(1);
    this.fboScratch.bind(1, 1);
    this.fboScratch.attachColor(src);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.FLOAT, buf);
    // 恢复离屏 FBO 与全分辨率视口，避免污染后续 pass / present
    this.fboScratch.bind(this.width, this.height);
    const mse = buf[0];
    if (!isFinite(mse) || mse < 1e-10) return 99;
    return 10 * Math.log10(1.0 / mse);
  }

  /**
   * 异步回读指定纹理的一块区域（RGBA8）。返回上一次请求的结果。
   * 用于车牌字符识别率统计，避免同步卡顿。
   */
  readRegionAsync(x: number, y: number, w: number, h: number, tex: Texture2D): Uint8Array | null {
    this.fboScratch.bind(this.width, this.height);
    this.fboScratch.attachColor(tex);
    return this.readback.read(x, y, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, Uint8Array);
  }

  /** 带 ID 的异步请求：先 request，数帧后 collect，保证不错位。 */
  requestRegion(x: number, y: number, w: number, h: number, tex: Texture2D): number {
    this.fboScratch.bind(this.width, this.height);
    this.fboScratch.attachColor(tex);
    return this.readback.request(x, y, w, h);
  }

  collectRegion(id: number): Uint8Array | null {
    return this.readback.collect(id);
  }

  /** 同步回读整图（仅小分辨率/调试用）。 */
  readPlateMaskRegion(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    this.fboScratch.bind(this.width, this.height);
    this.fboScratch.attachColor(this.texPlateMask);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  dispose(): void {
    this.readback.dispose();
  }
}
