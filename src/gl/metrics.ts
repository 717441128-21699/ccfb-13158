/**
 * 指标统计：
 *  - PSNR：GPU mipmap 归约，定时采样输入帧/输出帧相对晴天 GT；
 *  - 车牌可辨认率：用与场景 shader 完全一致的几何在 CPU 侧定位车牌，
 *    经 PBO 异步回读小图块后，用同一份 5x7 字形做归一化互相关（NCC），
 *    NCC 超过阈值判为可辨认。统计每 N 帧触发一次，不阻塞渲染循环。
 */
import { RenderPipeline } from './RenderPipeline';
import { FrameMetrics, EMPTY_METRICS } from '../types';
import { glyphBitmap, normalizedCorrelation, GLYPH_COUNT } from './font';

const NCC_THRESHOLD = 0.32;
const METRICS_INTERVAL = 12;
const EVAL_LATENCY = 5; // 回读延迟帧数（等待 fence signal）

interface PlateInfo {
  x: number; // readPixels 坐标（左下原点）
  y: number;
  w: number;
  h: number;
  chars: number[];
}

interface PendingPlate {
  plate: PlateInfo;
  inId: number;
  outId: number;
}

function fract(v: number): number {
  return v - Math.floor(v);
}
function hash11(p: number): number {
  const x = fract(p * 0.1031);
  return fract(x * (x + 33.33) * (x * (x + 33.33)));
}

/** 与 scene.frag / PLATE_MASK_FRAG 常量保持一致。 */
const CAM_H = 8;
const HORIZON = 0.38;
const TAN_MAX = 1.25;

export class MetricsEngine {
  private frameNo = 0;
  private psnrInEMA = 0;
  private psnrOutEMA = 0;
  private plateInRateEMA = 0;
  private plateOutRateEMA = 0;
  private plateInScoreEMA = 0;
  private plateOutScoreEMA = 0;
  private fpsEMA = 0;
  private frameMsEMA = 0;
  private pending: { plates: PendingPlate[]; readyAt: number } | null = null;

  constructor(private pipeline: RenderPipeline) {}

  private platesAt(time: number): PlateInfo[] {
    const W = this.pipeline.width;
    const H = this.pipeline.height;
    const plates: PlateInfo[] = [];
    for (let i = 0; i < 5; i++) {
      const fi = i;
      const lane = fi % 3;
      const cycle = 48 + fi * 7;
      const phase = fract(time / cycle + hash11(fi * 3.1));
      const zNear = fi === 0 ? 40 : 110;
      const z = zNear + (15 - zNear) * phase;
      if (z < 16 || z > 108) continue;
      const s = 1 / z;
      const tanTheta = CAM_H / z;
      const tt = tanTheta / TAN_MAX;
      const screenY = HORIZON + tt * (1 - HORIZON);
      const carW = 1.8 * s;
      const carH = 1.5 * s;
      const laneX = (lane - 1) * 3;
      const centerX = 0.5 + laneX * s;
      const bottomY = screenY;
      // 屏幕坐标（左上原点）
      const sx0 = (centerX - carW * 0.2) * W;
      const sx1 = (centerX + carW * 0.2) * W;
      const syTop = (bottomY + carH * 0.2) * H;
      const syBot = (bottomY + carH * 0.33) * H;
      const w = Math.floor(sx1 - sx0);
      const h = Math.floor(syBot - syTop);
      if (w < 8 || h < 3) continue;
      const chars = [
        10 + ((fi * 5) % 26),
        (fi * 3) % 10,
        (fi * 7 + 2) % 10,
        10 + ((fi * 11) % 26),
        (fi * 13 + 1) % 10,
        (fi * 17 + 4) % 10,
        (fi * 19 + 7) % 10,
      ];
      plates.push({
        x: Math.max(0, Math.floor(sx0)),
        y: Math.max(0, Math.floor(H - syBot)), // 转左下原点
        w,
        h,
        chars,
      });
    }
    // 只评估画面中最大的两块，控制回读带宽
    plates.sort((a, b) => b.w * b.h - a.w * a.h);
    return plates.slice(0, 2);
  }

  update(time: number, dtMs: number, isSynthetic: boolean): FrameMetrics {
    this.frameNo++;
    const a = 0.2;
    this.fpsEMA = this.fpsEMA * (1 - a) + (1000 / Math.max(dtMs, 0.01)) * a;
    this.frameMsEMA = this.frameMsEMA * (1 - a) + dtMs * a;

    if (isSynthetic && this.frameNo % METRICS_INTERVAL === 0) {
      const psnrIn = this.pipeline.computePSNR(this.pipeline.inputTexture, this.pipeline.sceneTexture);
      const psnrOut = this.pipeline.computePSNR(this.pipeline.finalTexture, this.pipeline.sceneTexture);
      this.psnrInEMA = this.psnrInEMA * 0.55 + psnrIn * 0.45;
      this.psnrOutEMA = this.psnrOutEMA * 0.55 + psnrOut * 0.45;
      this.issuePlateRequests(time);
    }
    if (this.pending && this.frameNo >= this.pending.readyAt) {
      this.collectAndEvaluate();
      this.pending = null;
    }
    return this.snapshot();
  }

  private issuePlateRequests(time: number): void {
    const plates = this.platesAt(time);
    const pendingPlates: PendingPlate[] = plates.map((p) => ({
      plate: p,
      inId: this.pipeline.requestRegion(p.x, p.y, p.w, p.h, this.pipeline.inputTexture),
      outId: this.pipeline.requestRegion(p.x, p.y, p.w, p.h, this.pipeline.finalTexture),
    }));
    (globalThis as unknown as { __plateDbg?: unknown }).__plateDbg = {
      stage: 'issued',
      plateCount: plates.length,
      plates: plates.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
    };
    this.pending = { plates: pendingPlates, readyAt: this.frameNo + EVAL_LATENCY };
  }

  private collectAndEvaluate(): void {
    if (!this.pending) return;
    let inRecognized = 0;
    let outRecognized = 0;
    let total = 0;
    let inScoreSum = 0;
    let outScoreSum = 0;
    let collected = 0;
    let nullBufs = 0;

    for (const pp of this.pending.plates) {
      const inBuf = this.pipeline.collectRegion(pp.inId);
      const outBuf = this.pipeline.collectRegion(pp.outId);
      if (!inBuf || !outBuf) { nullBufs++; continue; }
      collected++;
      this.evalPlate(pp.plate, inBuf, outBuf, (stat) => {
        total += stat.total;
        inRecognized += stat.inOk;
        outRecognized += stat.outOk;
        inScoreSum += stat.inScore;
        outScoreSum += stat.outScore;
      });
    }
    (globalThis as unknown as { __plateDbg?: unknown }).__plateDbg = {
      stage: 'collected', collected, nullBufs, total, inRecognized, outRecognized,
      pending: this.pending.plates.length,
    };

    if (total > 0) {
      const a = 0.4;
      this.plateInRateEMA = this.plateInRateEMA * (1 - a) + (inRecognized / total) * a;
      this.plateOutRateEMA = this.plateOutRateEMA * (1 - a) + (outRecognized / total) * a;
      this.plateInScoreEMA = this.plateInScoreEMA * (1 - a) + (inScoreSum / total) * a;
      this.plateOutScoreEMA = this.plateOutScoreEMA * (1 - a) + (outScoreSum / total) * a;
    }
  }

  private evalPlate(
    p: PlateInfo,
    inBuf: Uint8Array,
    outBuf: Uint8Array,
    cb: (s: { total: number; inOk: number; outOk: number; inScore: number; outScore: number }) => void,
  ): void {
    let total = 0;
    let inOk = 0;
    let outOk = 0;
    let inScore = 0;
    let outScore = 0;
    const cellW = Math.floor(p.w / 7);
    p.chars.forEach((charIdx, slot) => {
      const glyph = glyphBitmap(charIdx % GLYPH_COUNT);
      const x0 = slot * cellW;
      const inBlock = this.extractCell(inBuf, p.w, p.h, x0, cellW);
      const outBlock = this.extractCell(outBuf, p.w, p.h, x0, cellW);
      const nccIn = normalizedCorrelation(inBlock, cellW, p.h, glyph);
      const nccOut = normalizedCorrelation(outBlock, cellW, p.h, glyph);
      total++;
      inScore += Math.max(0, nccIn);
      outScore += Math.max(0, nccOut);
      if (nccIn > NCC_THRESHOLD) inOk++;
      if (nccOut > NCC_THRESHOLD) outOk++;
    });
    cb({ total, inOk, outOk, inScore, outScore });
  }

  private extractCell(buf: Uint8Array, stride: number, h: number, x0: number, cellW: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(cellW * h * 4);
    for (let y = 0; y < h; y++) {
      const srcOff = (y * stride + x0) * 4;
      out.set(buf.subarray(srcOff, srcOff + cellW * 4), y * cellW * 4);
    }
    return out;
  }

  private snapshot(): FrameMetrics {
    return {
      ...EMPTY_METRICS,
      psnrInput: this.psnrInEMA,
      psnrOutput: this.psnrOutEMA,
      psnrGain: this.psnrOutEMA - this.psnrInEMA,
      fps: this.fpsEMA,
      frameMs: this.frameMsEMA,
      plateInputRate: this.plateInRateEMA,
      plateOutputRate: this.plateOutRateEMA,
      plateInputScore: this.plateInScoreEMA,
      plateOutputScore: this.plateOutScoreEMA,
      width: this.pipeline.width,
      height: this.pipeline.height,
    };
  }

  reset(): void {
    this.frameNo = 0;
    this.psnrInEMA = 0;
    this.psnrOutEMA = 0;
    this.plateInRateEMA = 0;
    this.plateOutRateEMA = 0;
    this.plateInScoreEMA = 0;
    this.plateOutScoreEMA = 0;
    this.pending = null;
  }
}
