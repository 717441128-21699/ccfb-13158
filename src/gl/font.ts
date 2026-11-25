/**
 * 5x7 位图字形：GPU 车牌渲染与 CPU 识别率评估共用同一份字形定义，
 * 保证"可辨认率"统计基于已知真值字符，不依赖外部 OCR 库。
 * 图集排列：10 个数字 + 26 个大写字母 = 36 个字符，6 列 x 6 行。
 */

// 每个字符 7 行，每行 5 bit（bit4..bit0 对应左..右）
const FONT_5X7: number[] = [
  // 0
  0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
  // 1
  0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
  // 2
  0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
  // 3
  0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
  // 4
  0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
  // 5
  0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
  // 6
  0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
  // 7
  0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
  // 8
  0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
  // 9
  0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
  // A (10)
  0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
  // B
  0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
  // C
  0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111,
  // D
  0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
  // E
  0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
  // F
  0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
  // G
  0b01111, 0b10000, 0b10000, 0b10011, 0b10001, 0b10001, 0b01111,
  // H
  0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
  // I
  0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
  // J
  0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100,
  // K
  0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
  // L
  0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
  // M
  0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
  // N
  0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
  // O
  0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
  // P
  0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
  // Q
  0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
  // R
  0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
  // S
  0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
  // T
  0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
  // U
  0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
  // V
  0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
  // W
  0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001,
  // X
  0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
  // Y
  0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
  // Z
  0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
];

export const GLYPH_COLS = 6;
export const GLYPH_ROWS = 6;
export const GLYPH_COUNT = 36;
export const CELL_W = 8; // 含 3px 间距的单元尺寸
export const CELL_H = 10;
export const ATLAS_W = GLYPH_COLS * CELL_W; // 48
export const ATLAS_H = GLYPH_ROWS * CELL_H; // 60

/** 生成 R8 字形图集 canvas（白色字形、黑底）。 */
export function buildFontAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  ctx.fillStyle = '#fff';
  for (let i = 0; i < GLYPH_COUNT; i++) {
    const col = i % GLYPH_COLS;
    const row = Math.floor(i / GLYPH_COLS);
    const ox = col * CELL_W + 1;
    const oy = row * CELL_H + 1;
    for (let r = 0; r < 7; r++) {
      const bits = FONT_5X7[i * 7 + r];
      for (let c = 0; c < 5; c++) {
        if (bits & (1 << (4 - c))) ctx.fillRect(ox + c, oy + r, 1, 1);
      }
    }
  }
  return canvas;
}

/** 取某个字符的 5x7 二值矩阵（1=笔画），供 CPU 端 NCC 评估。 */
export function glyphBitmap(charIndex: number): Uint8Array {
  const out = new Uint8Array(35);
  const base = charIndex * 7;
  for (let r = 0; r < 7; r++) {
    const bits = FONT_5X7[base + r];
    for (let c = 0; c < 5; c++) {
      out[r * 5 + c] = bits & (1 << (4 - c)) ? 1 : 0;
    }
  }
  return out;
}

/**
 * 归一化互相关（NCC）：把图像小区缩放到 5x7 网格后与真值字形比较。
 * 车牌为蓝底白字，字形 1=白笔画。先对观测亮度做局部归一化（去底色、
 * 标准化反差），再与二值字形做相关，返回 -1..1，>阈值视为可辨认。
 */
export function normalizedCorrelation(cell: Uint8ClampedArray, cellW: number, cellH: number, glyph: Uint8Array): number {
  const observed = new Float32Array(35);
  let mean = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      const sx = Math.min(cellW - 1, Math.floor(((c + 0.5) / 5) * cellW));
      const sy = Math.min(cellH - 1, Math.floor(((r + 0.5) / 7) * cellH));
      const idx = (sy * cellW + sx) * 4;
      // 蓝底白字：白色笔画的 R/G/B 都高，取亮度即可
      const lum = 0.299 * cell[idx] + 0.587 * cell[idx + 1] + 0.114 * cell[idx + 2];
      observed[r * 5 + c] = lum;
      mean += lum;
    }
  }
  mean /= 35;
  // 观测标准差
  let oVar = 0;
  for (let i = 0; i < 35; i++) oVar += (observed[i] - mean) ** 2;
  const oStd = Math.sqrt(oVar / 35);
  if (oStd < 1e-3) return 0; // 整块纯色，无字符信息

  let gMean = 0;
  for (let i = 0; i < 35; i++) gMean += glyph[i];
  gMean /= 35;
  let num = 0;
  let db = 0;
  for (let i = 0; i < 35; i++) {
    const a = (observed[i] - mean) / oStd; // 标准化观测
    const b = glyph[i] - gMean;
    num += a * b;
    db += b * b;
  }
  if (db < 1e-6) return 0;
  // 观测已标准化为单位方差，字形中心化后做相关，结果约在 -1..1
  return num / Math.sqrt(db);
}
