/**
 * 监控源接入：
 *  - synthetic：内置程序化合成器（晴天 GT + 可调雨/水珠/光晕）
 *  - video：用户上传的监控录像文件
 *  - camera：本机 USB/网络摄像头（getUserMedia）
 * 外部模式没有晴天 GT，指标面板的 PSNR/车牌项自动隐藏。
 */
import { InputSourceKind } from '../types';

export class SourceManager {
  kind: InputSourceKind = 'synthetic';
  video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private objectUrl: string | null = null;

  async loadFile(file: File): Promise<HTMLVideoElement> {
    this.release();
    const video = document.createElement('video');
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    this.objectUrl = URL.createObjectURL(file);
    video.src = this.objectUrl;
    await video.play();
    this.video = video;
    this.kind = 'video';
    return video;
  }

  async openCamera(deviceId?: string): Promise<HTMLVideoElement> {
    this.release();
    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.video = video;
    this.kind = 'camera';
    return video;
  }

  useSynthetic(): void {
    this.release();
    this.kind = 'synthetic';
  }

  get frameReady(): boolean {
    if (this.kind === 'synthetic') return true;
    const v = this.video;
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  get dimensions(): { w: number; h: number } | null {
    if (this.kind === 'synthetic' || !this.video) return null;
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  release(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
  }
}
