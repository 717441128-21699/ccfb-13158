/**
 * 应用主控制器：帧循环、UI 绑定、四个页签联动、自适应画质与指标展示。
 * 单一 WebGL2 管线拥有全部纹理；多个 2D canvas 通过 drawImage 镜像
 * WebGL canvas 的不同呈现模式（输入/输出/GT/掩膜）。
 */
import './ui/styles.css';
import { RenderPipeline } from './gl/RenderPipeline';
import { MetricsEngine } from './gl/metrics';
import { SourceManager } from './core/SourceManager';
import { Recorder } from './core/Recorder';
import { DEFAULT_PARAMS, PipelineParams, DropletMark, FrameMetrics } from './types';

const WORK_W = 1920;
const WORK_H = 1080;
const TARGET_FPS = 25;

class App {
  private pipe!: RenderPipeline;
  private metrics!: MetricsEngine;
  private sources = new SourceManager();
  private recorder!: Recorder;
  private params: PipelineParams = { ...DEFAULT_PARAMS };
  private playing = true;
  private simTime = 0;
  private lastWall = 0;
  private seed = 7;
  private marks: DropletMark[] = [];
  private nextMarkId = 1;
  private markMode = false;
  private autoDrop = true;
  private qualityScale = 1;
  private autoQuality = true;
  private lowFpsCounter = 0;
  private markDrag: { x: number; y: number; r: number } | null = null;
  private glCanvas!: HTMLCanvasElement;

  private el = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  private canvas = (id: string): HTMLCanvasElement => document.getElementById(id) as unknown as HTMLCanvasElement;

  async start(): Promise<void> {
    // 构造完成即暴露测试钩子，避免异步链上的时序问题
    (window as unknown as { __rainGuard?: App }).__rainGuard = this;
    this.glCanvas = this.canvas('outputCanvas');
    this.glCanvas.width = WORK_W;
    this.glCanvas.height = WORK_H;
    this.pipe = new RenderPipeline(this.glCanvas);
    this.metrics = new MetricsEngine(this.pipe);
    this.recorder = new Recorder(this.glCanvas, TARGET_FPS);

    // 输入页画布改为 2D 镜像画布
    this.replaceWithMirrorCanvas('inputCanvas');
    this.bindTabs();
    this.bindControls();
    this.bindDropletCanvas();
    this.bindRecorder();

    this.applyQuality(1, true);
    this.lastWall = performance.now();
    this.loop();
  }

  /** 把占位 canvas 换成同尺寸 2D canvas，用于 drawImage 镜像。 */
  private replaceWithMirrorCanvas(id: string): void {
    const old = document.getElementById(id) as HTMLCanvasElement;
    const next = document.createElement('canvas');
    next.id = id;
    next.width = 480;
    next.height = 270;
    old.replaceWith(next);
  }

  private bindTabs(): void {
    const tabs = document.querySelectorAll<HTMLElement>('.tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const name = tab.dataset.tab!;
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
        document.querySelector(`.tab-pane[data-pane="${name}"]`)!.classList.add('active');
      });
    });
  }

  private bindControls(): void {
    const bindRange = (id: string, valId: string, apply: (v: number) => void,
      fmt: (v: number) => string = (v) => v.toFixed(2)): void => {
      const input = this.el(id);
      const label = document.getElementById(valId)!;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        label.textContent = fmt(v);
        apply(v);
      });
    };

    bindRange('rainIntensity', 'valRain', (v) => (this.params.rainIntensity = v));
    bindRange('rainAngle', 'valAngle', (v) => {
      this.params.rainAngleDeg = v;
      this.pipe.rainAngleRad = (v * Math.PI) / 180;
    }, (v) => `${v.toFixed(0)}°`);
    bindRange('dropletDensity', 'valDrop', (v) => (this.params.dropletDensity = v));
    bindRange('glareStrength', 'valGlare', (v) => (this.params.glareStrength = v));
    bindRange('seed', 'valSeed', (v) => (this.seed = v), (v) => v.toFixed(0));
    bindRange('rainThresh', 'valThresh', (v) => (this.params.rainCandidateThresh = v));
    bindRange('temporalFrames', 'valFrames', (v) => (this.params.temporalFrames = v), (v) => v.toFixed(0));
    bindRange('edgeGuard', 'valEdge', (v) => (this.params.edgeGuardStrength = v));
    bindRange('dropSense', 'valDropSense', (v) => (this.params.dropletSensitivity = v));
    bindRange('dropHold', 'valHold', (v) => (this.params.dropletHold = v));

    document.querySelectorAll<HTMLElement>('[data-preset-rain]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = parseFloat(btn.dataset.presetRain!);
        this.params.rainIntensity = v;
        this.el('rainIntensity').value = String(v);
        document.getElementById('valRain')!.textContent = v.toFixed(2);
      });
    });

    this.el('btnReseed').addEventListener('click', () => {
      this.seed = 1 + Math.floor(Math.random() * 99);
      this.el('seed').value = String(this.seed);
      document.getElementById('valSeed')!.textContent = String(this.seed);
    });

    this.el('btnPlayPause').addEventListener('click', () => {
      this.playing = !this.playing;
      this.el('btnPlayPause').textContent = this.playing ? '暂停' : '播放';
    });

    this.el('chkMask').addEventListener('change', (e) => {
      this.pipe.showMask = (e.target as HTMLInputElement).checked;
    });
    this.el('btnResetTemporal').addEventListener('click', () => {
      this.pipe.resetTemporal();
      this.metrics.reset();
    });

    document.querySelectorAll<HTMLElement>('.resolution-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.resolution-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const scale = parseFloat(btn.dataset.scale!);
        if (scale >= 1) {
          this.autoQuality = true;
          this.applyQuality(1, true);
        } else {
          this.autoQuality = false;
          this.applyQuality(scale, false);
        }
      });
    });

    this.el('btnSynthetic').addEventListener('click', () => {
      this.sources.useSynthetic();
      this.pipe.resetTemporal();
      this.metrics.reset();
      this.setStatus('合成源运行中', true);
    });

    this.el('fileInput').addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        await this.sources.loadFile(file);
        this.onExternalSource();
        this.setStatus(`已加载录像：${file.name}`, true);
      } catch (err) {
        this.setStatus(`录像加载失败：${(err as Error).message}`, false);
      }
    });

    this.el('btnCamera').addEventListener('click', async () => {
      try {
        await this.sources.openCamera();
        this.onExternalSource();
        this.setStatus('摄像头已接入', true);
      } catch (err) {
        this.setStatus(`摄像头打开失败：${(err as Error).message}`, false);
      }
    });
  }

  private onExternalSource(): void {
    const dim = this.sources.dimensions;
    if (dim) {
      this.pipe.resize(dim.w, dim.h);
      document.getElementById('resPill')!.textContent = `${dim.w}×${dim.h}`;
    }
    this.pipe.resetTemporal();
    this.metrics.reset();
    document.getElementById('metricsHint')!.textContent =
      '外部视频/摄像头无晴天真值帧，PSNR 与车牌可辨认率指标仅合成源可用。';
  }

  private setStatus(text: string, ok: boolean): void {
    const pill = document.getElementById('statusPill')!;
    pill.textContent = text;
    pill.className = `pill ${ok ? 'pill-ok' : 'pill-warn'}`;
  }

  private applyQuality(scale: number, reset: boolean): void {
    this.qualityScale = scale;
    const w = Math.round(WORK_W * scale);
    const h = Math.round(WORK_H * scale);
    // canvas 物理像素跟随工作分辨率（CSS 仍按容器缩放显示），
    // 保证 present 的 gl.viewport 正好铺满整个 canvas
    this.glCanvas.width = w;
    this.glCanvas.height = h;
    this.pipe.resize(w, h);
    this.pipe.rainAngleRad = (this.params.rainAngleDeg * Math.PI) / 180;
    document.getElementById('resPill')!.textContent =
      `${w}×${h}${scale < 1 ? '（降采样工作）' : ''}`;
    if (reset) this.lowFpsCounter = 0;
  }

  /** 测试/调试用：直接指定工作分辨率。 */
  setWorkSize(w: number, h: number): void {
    this.qualityScale = w / WORK_W;
    this.glCanvas.width = w;
    this.glCanvas.height = h;
    this.pipe.resize(w, h);
    this.pipe.rainAngleRad = (this.params.rainAngleDeg * Math.PI) / 180;
    document.getElementById('resPill')!.textContent = `${w}×${h}（测试分辨率）`;
  }

  // ---------- 水珠标注 ----------
  private bindDropletCanvas(): void {
    const canvas = this.canvas('dropCanvas');
    this.el('btnAddMark').addEventListener('click', () => {
      this.markMode = !this.markMode;
      this.el('btnAddMark').textContent = this.markMode ? '退出画水珠模式' : '画水珠模式';
      canvas.style.cursor = this.markMode ? 'crosshair' : 'default';
    });
    this.el('btnClearMarks').addEventListener('click', () => {
      this.marks = [];
      this.syncMarks();
    });
    this.el('chkAutoDrop').addEventListener('change', (e) => {
      this.autoDrop = (e.target as HTMLInputElement).checked;
      this.params.dropletSensitivity = this.autoDrop ? 0.6 : 0;
      this.el('dropSense').value = this.autoDrop ? '0.6' : '0';
      document.getElementById('valDropSense')!.textContent = this.params.dropletSensitivity.toFixed(2);
    });

    const toUv = (ev: MouseEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) / rect.width,
        y: 1 - (ev.clientY - rect.top) / rect.height,
      };
    };
    canvas.addEventListener('mousedown', (ev) => {
      if (!this.markMode) return;
      const p = toUv(ev);
      this.markDrag = { x: p.x, y: p.y, r: 0.01 };
    });
    canvas.addEventListener('mousemove', (ev) => {
      if (!this.markDrag) return;
      const p = toUv(ev);
      this.markDrag.r = Math.hypot(p.x - this.markDrag.x, p.y - this.markDrag.y);
    });
    canvas.addEventListener('mouseup', () => {
      if (!this.markDrag) return;
      if (this.markDrag.r > 0.004) {
        this.marks.push({
          id: this.nextMarkId++,
          x: this.markDrag.x,
          y: this.markDrag.y,
          radius: this.markDrag.r,
        });
        this.syncMarks();
      }
      this.markDrag = null;
    });
  }

  private syncMarks(): void {
    this.pipe.setMarks(this.marks);
    const list = document.getElementById('markList')!;
    if (this.marks.length === 0) {
      list.innerHTML = '<li class="hint">暂无标注</li>';
      return;
    }
    list.innerHTML = '';
    this.marks.forEach((m) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>水珠 #${m.id} · 半径 ${(m.radius * 100).toFixed(1)}%</span>`;
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', () => {
        this.marks = this.marks.filter((x) => x.id !== m.id);
        this.syncMarks();
      });
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  // ---------- 录制 ----------
  private bindRecorder(): void {
    this.el('btnRecord').addEventListener('click', async () => {
      if (this.recorder.recording) {
        const blob = await this.recorder.stop();
        const name = `rain-guard-${Date.now()}.${this.recorder.extension}`;
        this.recorder.download(blob, name);
        this.addRecordingEntry(name, blob);
        this.el('btnRecord').textContent = '● 开始录制';
        document.getElementById('recStatus')!.textContent = '录制已停止并下载。';
      } else {
        this.recorder.start();
        this.el('btnRecord').textContent = '■ 停止录制';
        document.getElementById('recStatus')!.innerHTML =
          '<span class="rec-dot"></span> 正在录制处理后画面…';
      }
    });
    this.el('btnSnapshot').addEventListener('click', () => {
      this.recorder.snapshot(`rain-guard-${Date.now()}.png`);
    });
  }

  private addRecordingEntry(name: string, blob: Blob): void {
    const list = document.getElementById('recList')!;
    if (list.querySelector('.hint')) list.innerHTML = '';
    const li = document.createElement('li');
    const sizeMb = (blob.size / 1024 / 1024).toFixed(2);
    li.innerHTML = `<span>${name}（${sizeMb} MB）</span>`;
    const dl = document.createElement('button');
    dl.textContent = '下载';
    dl.addEventListener('click', () => this.recorder.download(blob, name));
    li.appendChild(dl);
    list.appendChild(li);
  }

  // ---------- 主循环 ----------
  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = now - this.lastWall;
    this.lastWall = now;
    if (this.playing) this.simTime += dt / 1000;

    const t0 = performance.now();
    const isSynthetic = this.sources.kind === 'synthetic';

    if (isSynthetic) {
      this.pipe.renderSynthetic(this.simTime, this.params, this.seed);
    } else if (this.sources.frameReady && this.sources.video) {
      this.pipe.uploadExternalFrame(this.sources.video);
    }

    this.pipe.process(this.params, this.simTime, isSynthetic);
    // 主画布呈现最终结果（captureStream 录制的也是它）
    this.pipe.present(0);
    const gpuMs = performance.now() - t0;

    this.paintMirrorCanvases(isSynthetic);
    const m = this.metrics.update(this.simTime, Math.max(gpuMs, dt), isSynthetic);
    this.renderMetrics(m, isSynthetic);
    if (this.autoQuality) this.adaptQuality(m);

    document.getElementById('timeLabel')!.textContent = `t = ${this.simTime.toFixed(1)} s`;
  };

  /**
   * 通过切换 present 模式把不同纹理送到同一 WebGL canvas，
   * 再 drawImage 到各 2D 镜像画布。每次只画 1x1 视口的轻量 blit。
   */
  private paintMirrorCanvases(isSynthetic: boolean): void {
    const mirrors: [string, number][] = [
      ['inputCanvas', 1],
      ['gtCanvas', 2],
      ['maskCanvas', 3],
      ['dropCanvas', 0],
      ['recordCanvas', 0],
    ];
    for (const [id, mode] of mirrors) {
      const canvas = document.getElementById(id) as HTMLCanvasElement | null;
      if (!canvas || canvas === this.glCanvas) continue;
      if (!isSynthetic && mode === 2) {
        this.paintNoGT(canvas);
        continue;
      }
      this.pipe.present(mode);
      const ctx = canvas.getContext('2d')!;
      if (canvas.width !== this.glCanvas.width) {
        canvas.width = this.glCanvas.width;
        canvas.height = this.glCanvas.height;
      }
      ctx.drawImage(this.glCanvas, 0, 0, canvas.width, canvas.height);
      if (id === 'dropCanvas') this.drawMarkOverlay(canvas);
    }
    // 恢复主画布为最终结果
    this.pipe.present(0);
  }

  private paintNoGT(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#93a4bd';
    ctx.font = '20px sans-serif';
    ctx.fillText('外部源无晴天真值', 20, canvas.height / 2);
  }

  private drawMarkOverlay(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    ctx.save();
    ctx.strokeStyle = 'rgba(34,211,238,0.9)';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(34,211,238,0.12)';
    for (const m of this.marks) {
      const cx = m.x * W;
      const cy = (1 - m.y) * H;
      const r = m.radius * Math.min(W, H);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (this.markDrag) {
      ctx.strokeStyle = 'rgba(245,158,11,0.95)';
      const cx = this.markDrag.x * W;
      const cy = (1 - this.markDrag.y) * H;
      ctx.beginPath();
      ctx.arc(cx, cy, this.markDrag.r * Math.min(W, H), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderMetrics(m: FrameMetrics, isSynthetic: boolean): void {
    const set = (id: string, text: string): void => {
      document.getElementById(id)!.textContent = text;
    };
    if (!isSynthetic) {
      for (const id of ['mPsnrIn', 'mPsnrOut', 'mPsnrGain', 'mPlateIn', 'mPlateOut', 'mPlateRatio']) {
        set(id, 'N/A');
      }
    } else {
      set('mPsnrIn', `${m.psnrInput.toFixed(2)} dB`);
      set('mPsnrOut', `${m.psnrOutput.toFixed(2)} dB`);
      const gainEl = document.getElementById('mPsnrGain')!;
      gainEl.textContent = `+${m.psnrGain.toFixed(2)} dB`;
      gainEl.style.color = m.psnrGain >= 8 ? '#22c55e' : '#f59e0b';
      set('mPlateIn', `${(m.plateInputRate * 100).toFixed(0)}%`);
      set('mPlateOut', `${(m.plateOutputRate * 100).toFixed(0)}%`);
      const ratio = m.plateInputRate > 0.02 ? m.plateOutputRate / m.plateInputRate : 0;
      const ratioEl = document.getElementById('mPlateRatio')!;
      ratioEl.textContent = ratio > 0 ? `${ratio.toFixed(2)}×` : '—';
      ratioEl.style.color = ratio >= 2 ? '#22c55e' : '#f59e0b';
    }
    set('mFps', `${m.fps.toFixed(1)} fps`);
    set('mMs', `${m.frameMs.toFixed(1)} ms`);
  }

  private adaptQuality(m: FrameMetrics): void {
    if (m.fps <= 0) return;
    if (m.fps < TARGET_FPS - 2) {
      this.lowFpsCounter++;
      if (this.lowFpsCounter > 60 && this.qualityScale > 0.5) {
        this.applyQuality(Math.max(0.5, this.qualityScale - 0.25), true);
      }
    } else if (m.fps > TARGET_FPS + 5 && this.qualityScale < 1) {
      this.lowFpsCounter = Math.max(0, this.lowFpsCounter - 2);
      if (this.lowFpsCounter === 0) this.applyQuality(Math.min(1, this.qualityScale + 0.25), true);
    } else {
      this.lowFpsCounter = Math.max(0, this.lowFpsCounter - 1);
    }
  }
}

new App().start().catch((err) => {
  console.error(err);
  const root = document.querySelector('.tab-body')!;
  const div = document.createElement('div');
  div.style.cssText = 'color:#fca5a5;padding:24px;font-size:14px;';
  div.textContent = `初始化失败：${err.message}`;
  root.prepend(div);
});
