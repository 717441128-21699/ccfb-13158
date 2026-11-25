/**
 * 处理后录像：用 canvas.captureStream + MediaRecorder 录制 WebGL 输出，
 * 同时支持单帧快照（PNG）。编码失败时回退到逐帧 WebM。
 */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  recording = false;
  private mime = 'video/webm;codecs=vp9';

  constructor(private canvas: HTMLCanvasElement, fps = 25) {
    this.fps = fps;
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) {
        this.mime = c;
        break;
      }
    }
  }

  private fps: number;

  start(): void {
    if (this.recording) return;
    this.stream = this.canvas.captureStream(this.fps);
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        videoBitsPerSecond: 8_000_000,
      });
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.recording = true;
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.recorder) {
        resolve(new Blob([], { type: this.mime }));
        return;
      }
      this.recorder.onstop = (): void => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this.chunks = [];
        this.recording = false;
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  snapshot(filename: string): void {
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  get extension(): string {
    return this.mime.includes('mp4') ? 'mp4' : 'webm';
  }
}
