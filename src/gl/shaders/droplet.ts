/**
 * 镜头水珠检测与修补。
 * 水珠特点：位置几乎不动、局部折射变形（锐度异常 + 圆形暗环）、
 * 在多帧中持续存在。检测在半分辨率运行以省带宽，证据纹理做 EMA 累积，
 * 再经形态学闭运算/尺寸过滤得到稳定掩膜。修补优先用时序中值（取其他帧
 * 未被遮挡时的画面），置信不足处回退到金字塔空间修补。
 */

/** Pass D1: 半分辨率特征——局部锐度方差、圆环状边缘强度、与历史帧的静态性 */
export const DROPLET_FEATURES_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uPrev;       // 上一帧输入（半分辨率）
uniform vec2 uTexel;           // 半分辨率 texel
uniform float uSensitivity;
out vec4 fragColor;

float lumaAt(vec2 uv) {
  return dot(texture(uInput, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float c = lumaAt(uv);

  // 局部锐度：中心与 4 邻域均值之差的能量（折射斑内部纹理扭曲、能量异常）
  float sum = 0.0;
  sum += lumaAt(uv + vec2(1, 0) * uTexel);
  sum += lumaAt(uv - vec2(1, 0) * uTexel);
  sum += lumaAt(uv + vec2(0, 1) * uTexel);
  sum += lumaAt(uv - vec2(0, 1) * uTexel);
  float mean4 = sum * 0.25;
  float sharp = abs(c - mean4);

  // 环形边缘：半径 r 上的边缘强度高于中心，模拟水珠暗环。
  // 同时记录 8 方向响应，水珠各向同性、道路/雾带各向异性。
  float ring = 0.0;
  float dirResp[8];
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 off = vec2(cos(a), sin(a)) * uTexel * 3.0;
    float dr = abs(lumaAt(uv + off) - lumaAt(uv + off * 1.6));
    dirResp[i] = dr;
    ring += dr;
  }
  ring /= 8.0;
  // 圆度：方向响应标准差越小越接近圆形 blob
  float ringVar = 0.0;
  for (int i = 0; i < 8; i++) {
    ringVar += (dirResp[i] - ring) * (dirResp[i] - ring);
  }
  ringVar /= 8.0;
  float circularity = 1.0 - smoothstep(0.002, 0.02, ringVar);

  // 静态性：与上一帧差异小（水珠位置不动；运动车辆/流动车道虚线会产生大差异）
  float prevL = dot(texture(uPrev, uv).rgb, vec3(0.299, 0.587, 0.114));
  float staticness = 1.0 - smoothstep(0.02, 0.12, abs(c - prevL));

  // 综合证据分：必须同时具备圆形 blob 形态与静态性，排除长条道路边缘/雾带
  float score = (sharp * 1.6 + ring * 2.6) * staticness * (0.35 + 0.65 * circularity);
  float raw = smoothstep(0.12 - uSensitivity * 0.06, 0.26 - uSensitivity * 0.08, score);

  fragColor = vec4(score, raw, staticness, c);
}
`;

/** Pass D2: 证据 EMA 累积 + 形态学闭运算（先膨胀后腐蚀），输出稳定掩膜。
 *  uMode 0=累积(读 uFeature+uEvidence) 1=膨胀 2=腐蚀（都只读写 uEvidence）。 */
export const DROPLET_ACCUM_FRAG = /* glsl */ `
uniform sampler2D uFeature;   // D1 输出 G=raw
uniform sampler2D uEvidence;  // R=累积证据, G=上一步掩膜
uniform vec2 uTexel;
uniform float uHold;
uniform float uMode;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  if (uMode < 0.5) {
    float raw = texture(uFeature, uv).g;
    float ev = texture(uEvidence, uv).r;
    ev = ev * uHold + raw * (1.0 - uHold);
    float mask = smoothstep(0.42, 0.6, ev);
    fragColor = vec4(ev, mask, 0.0, 1.0);
    return;
  }
  // 形态学在 G 通道（当前掩膜）上做，R 通道证据原样保留
  float ev = texture(uEvidence, uv).r;
  float v = texture(uEvidence, uv).g;
  float acc = v;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) continue;
      float n = texture(uEvidence, uv + vec2(x, y) * uTexel).g;
      if (uMode < 1.5) acc = max(acc, n); // 膨胀
      else acc = min(acc, n);              // 腐蚀，顺带去掉孤立小斑
    }
  }
  fragColor = vec4(ev, acc, 0.0, 1.0);
}
`;

/** Pass D3: 全分辨率掩膜上采样 + 手动标注合并（用户画的水珠圆强制置 1）。
 *  半分辨率纹理用线性过滤直接采样即完成上采样。 */
export const DROPLET_UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D uMaskHalf;
uniform vec2 uTexel;          // 全分辨率 texel
uniform vec4 uMarks[32];      // xy=归一化中心(左下原点), z=归一化半径, w=有效
uniform int uMarkCount;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // 线性采样半分辨率掩膜 = 双线性上采样；再与相邻区域平均软化边缘
  float m = texture(uMaskHalf, uv).g;
  float soft = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      soft += texture(uMaskHalf, uv + vec2(x, y) * uTexel).g;
    }
  }
  soft /= 9.0;
  m = max(m, soft);
  for (int i = 0; i < 32; i++) {
    if (i >= uMarkCount) break;
    vec4 mk = uMarks[i];
    if (mk.w < 0.5) continue;
    float d = distance(uv, mk.xy);
    m = max(m, 1.0 - smoothstep(mk.z * 0.9, mk.z * 1.1, d));
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

/** Pass D4: 水珠修补。
 *  - 掩膜内：时序中值（其他帧未遮挡的真实画面）为主；
 *  - 历史帧同样被该静态水珠遮挡，因此用"空间金字塔修补"兜底：
 *    对掩膜像素沿八方向找最近的未掩膜像素做距离加权混合。
 */
export const DROPLET_INPAINT_FRAG = /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uMask;
uniform sampler2D uFrames0;
uniform sampler2D uFrames1;
uniform sampler2D uFrames2;
uniform sampler2D uFrames3;
uniform sampler2D uFrames4;
uniform sampler2D uFrames5;
uniform sampler2D uFrames6;
uniform int uFrameCount;
uniform vec2 uTexel;
out vec4 fragColor;

vec3 frameSample(int i, vec2 uv) {
  if (i == 0) return texture(uFrames0, uv).rgb;
  if (i == 1) return texture(uFrames1, uv).rgb;
  if (i == 2) return texture(uFrames2, uv).rgb;
  if (i == 3) return texture(uFrames3, uv).rgb;
  if (i == 4) return texture(uFrames4, uv).rgb;
  if (i == 5) return texture(uFrames5, uv).rgb;
  return texture(uFrames6, uv).rgb;
}

vec3 medianColor(vec2 uv) {
  vec3 s[7];
  int n = min(uFrameCount, 7);
  for (int i = 0; i < 7; i++) {
    if (i < n) s[i] = frameSample(i, uv);
  }
  for (int i = 1; i < 7; i++) {
    if (i >= n) break;
    vec3 key = s[i];
    float kl = dot(key, vec3(0.299, 0.587, 0.114));
    int j = i - 1;
    for (int k = 0; k < 7; k++) {
      if (j < 0) break;
      if (dot(s[j], vec3(0.299, 0.587, 0.114)) <= kl) break;
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = key;
  }
  return s[n / 2];
}

// 八方向空间修补：沿射线步进直到掩膜外，按距离倒数加权
vec3 spatialInpaint(vec2 uv, float maskHere) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    for (int stepi = 2; stepi <= 24; stepi += 2) {
      vec2 p = uv + dir * uTexel * float(stepi);
      float m = texture(uMask, p).r;
      if (m < 0.25) {
        float w = 1.0 / float(stepi);
        acc += texture(uCurrent, p).rgb * w;
        wsum += w;
        break;
      }
    }
  }
  if (wsum <= 0.0) return texture(uCurrent, uv).rgb;
  return acc / wsum;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float m = texture(uMask, uv).r;
  vec3 cur = texture(uCurrent, uv).rgb;
  if (m <= 0.02) {
    fragColor = vec4(cur, 0.0);
    return;
  }
  vec3 temporal = medianColor(uv);
  vec3 spatial = spatialInpaint(uv, m);
  // 静态水珠在所有历史帧都存在 -> 时序结果仍带折射，按掩膜置信度混合空间修补
  vec3 repaired = mix(temporal, spatial, clamp(m * 0.85, 0.0, 0.9));
  fragColor = vec4(mix(cur, repaired, clamp(m, 0.0, 1.0)), m);
}
`;
