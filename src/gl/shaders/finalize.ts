/**
 * 收尾合成：光晕压制、去雾化、轻锐化，输出最终可显示/录制画面。
 */
export const FINALIZE_FRAG = /* glsl */ `
uniform sampler2D uInput;     // 水珠修补后的画面
uniform sampler2D uRainMask;  // 雨线掩膜（仅用于统计可视化）
uniform sampler2D uDropMask;  // 水珠掩膜
uniform vec2 uTexel;
uniform float uGlare;         // 光晕压制强度 0..1
uniform float uShowMask;      // 1=叠加掩膜可视化
out vec4 fragColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 col = texture(uInput, uv).rgb;

  // ---- 光晕压制 ----
  // 1) 局部平均亮度估计光晕背景
  vec3 local = vec3(0.0);
  float wsum = 0.0;
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      float w = exp(-float(x * x + y * y) / 12.0);
      local += texture(uInput, uv + vec2(x, y) * uTexel).rgb * w;
      wsum += w;
    }
  }
  local /= wsum;
  float lNow = luma(col);
  float lLocal = luma(local);
  // 2) 明显高于局部背景的高亮 -> 压亮 + 降饱和（车灯光晕而非车灯本身全压）
  float excess = smoothstep(0.12, 0.45, lNow - lLocal);
  vec3 deGlare = col - (col - local) * excess * 0.55 * uGlare;
  // 3) 暖色辉光（雨夜车灯）额外衰减
  float warm = smoothstep(0.5, 0.9, col.r) * step(col.b, col.r * 0.95);
  deGlare -= vec3(0.12, 0.08, 0.02) * warm * uGlare;
  col = deGlare;

  // ---- 去雾化：轻微拉伸对比、去冷灰罩 ----
  float l = luma(col);
  col = (col - l) * 1.12 + l;
  col = (col - 0.5) * 1.08 + 0.5;
  col += vec3(0.02, 0.01, 0.0); // 抵消冷色偏移

  // ---- 轻锐化（3x3 反掩膜），恢复修补区域的清晰度 ----
  vec3 blur = vec3(0.0);
  blur += texture(uInput, uv + vec2(1, 0) * uTexel).rgb;
  blur += texture(uInput, uv - vec2(1, 0) * uTexel).rgb;
  blur += texture(uInput, uv + vec2(0, 1) * uTexel).rgb;
  blur += texture(uInput, uv - vec2(0, 1) * uTexel).rgb;
  blur *= 0.25;
  col += (col - blur) * 0.35;

  col = clamp(col, 0.0, 1.0);

  if (uShowMask > 0.5) {
    float rm = texture(uRainMask, uv).a;
    float dm = texture(uDropMask, uv).r;
    col = mix(col, vec3(1.0, 0.35, 0.1), rm * 0.45);   // 雨线：橙色
    col = mix(col, vec3(0.15, 0.55, 1.0), dm * 0.45);  // 水珠：蓝色
  }
  fragColor = vec4(col, 1.0);
}
`;

/**
 * PSNR 归约第一级：每个纹素计算与 GT 的平方误差，写入 R32F。
 */
export const SSE_FRAG = /* glsl */ `
uniform sampler2D uImg;
uniform sampler2D uGT;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 a = texture(uImg, uv).rgb;
  vec3 b = texture(uGT, uv).rgb;
  vec3 d = a - b;
  fragColor = vec4(dot(d, d) / 3.0, 0.0, 0.0, 1.0);
}
`;

/**
 * 归约后续级：2x2 box 平均，每次宽高减半，直到 1x1。
 * 用 NEAREST 采样 + 显式偏移，不依赖硬件 mipmap 对浮点格式的支持。
 */
export const REDUCE_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uSrcTexel;   // 源纹理 texel
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uSrcTexel * 2.0;
  float s =
    texture(uInput, uv).r +
    texture(uInput, uv + vec2(uSrcTexel.x, 0.0)).r +
    texture(uInput, uv + vec2(0.0, uSrcTexel.y)).r +
    texture(uInput, uv + uSrcTexel).r;
  fragColor = vec4(s * 0.25, 0.0, 0.0, 1.0);
}
`;

/** 半分辨率降采样（用于水珠检测链路与运动估计），带 2x2 box */
export const DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uTexel;   // 源（全分辨率）texel
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel * 2.0;
  vec3 c = texture(uInput, uv).rgb
         + texture(uInput, uv + vec2(uTexel.x, 0.0)).rgb
         + texture(uInput, uv + vec2(0.0, uTexel.y)).rgb
         + texture(uInput, uv + uTexel).rgb;
  fragColor = vec4(c * 0.25, 1.0);
}
`;

/** 简单拷贝 / 格式转换 pass */
export const COPY_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  fragColor = vec4(texture(uInput, uv).rgb, 1.0);
}
`;
