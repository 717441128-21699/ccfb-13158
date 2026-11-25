/** 全局参数：由 UI 控制，逐帧只读传入管线。 */
export interface PipelineParams {
  // 合成退化
  rainIntensity: number; // 0..1 雨量
  rainAngleDeg: number; // 雨线方向（与竖直方向的夹角，度）
  dropletDensity: number; // 0..1 镜头水珠密度
  glareStrength: number; // 0..1 车灯光晕
  // 去雨
  rainCandidateThresh: number; // 亮度突变阈值
  temporalFrames: number; // 时序窗口（中值帧数）
  edgeGuardStrength: number; // 边缘保护强度  // 水珠
  dropletSensitivity: number; // 检测灵敏度
  dropletHold: number; // 证据累积保持系数
  // 通用
  qualityScale: number; // 工作分辨率比例 0.5 / 0.75 / 1
}

export const DEFAULT_PARAMS: PipelineParams = {
  rainIntensity: 0.6,
  rainAngleDeg: 12,
  dropletDensity: 0.55,
  glareStrength: 0.7,
  rainCandidateThresh: 0.1,
  temporalFrames: 7,
  edgeGuardStrength: 1.0,
  dropletSensitivity: 0.6,
  dropletHold: 0.92,
  qualityScale: 1,
};

export type InputSourceKind = 'synthetic' | 'video' | 'camera';

export interface SourceConfig {
  kind: InputSourceKind;
  /** 视频/摄像头模式下的元素 */
  videoEl: HTMLVideoElement | null;
  playing: boolean;
  time: number; // 合成模式的秒
}

export interface FrameMetrics {
  psnrInput: number; // 雨天输入 vs 真值 dB
  psnrOutput: number; // 处理后 vs 真值 dB
  psnrGain: number;
  fps: number;
  frameMs: number;
  plateInputRate: number; // 0..1 输入帧车牌字符可辨认率
  plateOutputRate: number; // 0..1 输出帧
  plateInputScore: number; // 平均 NCC
  plateOutputScore: number;
  width: number;
  height: number;
}

export const EMPTY_METRICS: FrameMetrics = {
  psnrInput: 0,
  psnrOutput: 0,
  psnrGain: 0,
  fps: 0,
  frameMs: 0,
  plateInputRate: 0,
  plateOutputRate: 0,
  plateInputScore: 0,
  plateOutputScore: 0,
  width: 0,
  height: 0,
};

/** 手动水珠标注：归一化坐标圆 */
export interface DropletMark {
  id: number;
  x: number;
  y: number;
  radius: number;
}
