/**
 * 雨线检测与修补着色器。
 * 雨线特征：又细又亮的斜条纹、方向大致一致。用沿雨线方向的一维
 * 定向 DoG（高斯差分）响应定位亮条纹，Sobel 边缘图保护车辆/车道线
 * 等结构性边缘，再经多帧时序验证剔除静态结构。
 */

/** Pass 1: 亮度 + Sobel 边缘强度 + 定向雨线响应，输出到 RGBA16F */
export const RAIN_FEATURES_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uTexel;
uniform float uAngle;       // 雨线方向角（与竖直夹角，弧度）
uniform float uThresh;      // 响应阈值
uniform float uEdgeGuard;   // 边缘保护强度
out vec4 fragColor;

float lumaAt(vec2 uv) {
  vec3 c = texture(uInput, uv).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float L = lumaAt(uv);

  // --- Sobel 边缘（结构边缘：车道线、车辆轮廓、字符）---
  float tl = lumaAt(uv + uTexel * vec2(-1, -1));
  float tc = lumaAt(uv + uTexel * vec2(0, -1));
  float tr = lumaAt(uv + uTexel * vec2(1, -1));
  float ml = lumaAt(uv + uTexel * vec2(-1, 0));
  float mr = lumaAt(uv + uTexel * vec2(1, 0));
  float bl = lumaAt(uv + uTexel * vec2(-1, 1));
  float bc = lumaAt(uv + uTexel * vec2(0, 1));
  float br = lumaAt(uv + uTexel * vec2(1, 1));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float edge = length(vec2(gx, gy));
  // 边缘方向角：梯度方向。雨线梯度垂直于雨线自身方向，
  // 即雨线梯度方向 ≈ nrm；结构边缘（车道线、车辆）方向各异。
  float edgeAngle = atan(gy, gx);
  vec2 dir = normalize(vec2(sin(uAngle), cos(uAngle)));
  vec2 nrm = vec2(-dir.y, dir.x);
  float nrmAngle = atan(nrm.y, nrm.x);
  // 边缘方向与雨线法线的夹角：越小越可能是雨线本身
  float angleDiff = abs(atan(sin(edgeAngle - nrmAngle), cos(edgeAngle - nrmAngle)));
  float along = 0.0;
  float wsum = 0.0;
  for (int k = -10; k <= 10; k++) {
    float w = exp(-float(k * k) / 40.0);
    along += lumaAt(uv + dir * uTexel * float(k) * 1.8) * w;
    wsum += w;
  }
  along /= wsum;
  // 垂直方向窄 DoG（中心亮、两侧暗）——雨线的核心高频特征
  float c = lumaAt(uv);
  float s1 = lumaAt(uv + nrm * uTexel * 1.5);
  float s2 = lumaAt(uv - nrm * uTexel * 1.5);
  float dog = c * 2.0 - s1 - s2;
  // 沿方向均值作为基线，雨线相对基线明显偏亮
  float brightLift = c - along;

  // 方向一致性：雨线沿 dir 方向亮度变化小（细长），垂直方向变化大。
  // 用沿/垂两方向的梯度能量比做门控，宽雾带、水平结构比值接近 1，被排除。
  float gradAlong = abs(lumaAt(uv + dir * uTexel * 2.0) - lumaAt(uv - dir * uTexel * 2.0));
  float gradPerp = abs(s1 - s2);
  float anisotropy = gradPerp / (gradAlong + 0.02);
  float thinOriented = smoothstep(1.0, 2.0, anisotropy);

  // 雨线触发依赖垂直雨线方向的 DoG（雨线独有特征）；
  // brightLift 仅作"必须偏亮"的符号门控，不参与幅度，避免宽亮雾带误检。
  float response = max(dog, 0.0) * 2.2;

  // 候选：响应超阈值 + 方向细长，且不是强结构边缘。
  // 道路边界/车道线/车辆轮廓的 Sobel 边缘强度远高于雨线，强抑制。
  // 边缘保护改为按方向：只有方向明显偏离雨线法线的结构边缘才压制。
  // 沿雨线方向的边缘（angleDiff 小）视为雨线，不压制；横向/斜向结构边缘压制。
  float structureEdge = smoothstep(0.35, 0.7, angleDiff) * smoothstep(0.1, 0.3, edge);
  float edgeSuppression = structureEdge * uEdgeGuard;
  float candidate = smoothstep(uThresh, uThresh + 0.12, response);
  candidate *= 1.0 - clamp(edgeSuppression, 0.0, 1.0);
  candidate *= thinOriented;
  // 雨线必须偏亮（暗裂纹之类的不处理）
  candidate *= step(0.0, brightLift + 0.02);

  fragColor = vec4(L, edge, response, candidate);
}
`;

/** Pass 2: 时序验证。雨线在固定像素处时隐时现（移动），
 *  统计历史 N 帧中候选命中比例，只保留"有时出现"而非"永远存在"的点；
 *  同时输出膨胀后的雨线掩膜供修补使用。 */
export const RAIN_TEMPORAL_FRAG = /* glsl */ `
uniform sampler2D uFeature;      // 当前帧特征 (L, edge, resp, candidate)
uniform sampler2D uHistory;      // R=历史候选累积命中, G=历史观测次数
uniform vec2 uTexel;
uniform float uHold;            // 累积衰减
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 f = texture(uFeature, uv);
  float cand = f.a;
  vec4 h = texture(uHistory, uv);
  float hit = h.r * uHold + cand;
  float seen = h.g * uHold + 1.0;
  float rate = hit / max(seen, 1.0);
  // 时序只用于排除恒亮静态结构（白车道线/路缘 rate≈1）；
  // 移动雨线命中率分布较广，下限放宽，主要靠空间定向特征把关。
  float notStatic = 1.0 - smoothstep(0.82, 0.97, rate);
  float seenEnough = smoothstep(0.03, 0.12, rate);
  // 邻域候选密度：雨线成条出现，孤立噪点密度低
  float neigh = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      neigh += texture(uFeature, uv + vec2(x, y) * uTexel).a;
    }
  }
  neigh /= 9.0;
  float lineSupport = smoothstep(0.12, 0.4, neigh);
  // 当前帧空间候选为主，时序门控仅排除静态结构
  float mask = cand * notStatic * lineSupport * seenEnough;
  // 与上帧掩膜短时或，跟随雨线移动、填补单帧漏检
  float temporal = max(mask, h.b * 0.65);

  // 3x3 膨胀，掩膜覆盖整条亮纹
  float dil = temporal;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(x, y) * uTexel;
      vec4 nf = texture(uFeature, uv + o);
      vec4 nh = texture(uHistory, uv + o);
      float nrate = nh.r / max(nh.g, 1.0);
      float nNotStatic = 1.0 - smoothstep(0.82, 0.97, nrate);
      dil = max(dil, nf.a * nNotStatic);
    }
  }
  fragColor = vec4(hit, seen, temporal, clamp(dil, 0.0, 1.0));
}
`;

/** Pass 3: 雨线修补。对掩膜内像素取时序窗口中值（自动避开被雨线
 *  污染的帧），掩膜外保留当前像素。输出 RGB 修补结果 + 掩膜。
 *  注意：GLSL ES 3.0 中 sampler 数组只能用常量表达式索引，需显式展开。 */
export const RAIN_INPAINT_FRAG = /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uMask;       // RAIN_TEMPORAL 输出, A=膨胀掩膜
uniform sampler2D uFrames0;
uniform sampler2D uFrames1;
uniform sampler2D uFrames2;
uniform sampler2D uFrames3;
uniform sampler2D uFrames4;
uniform sampler2D uFrames5;
uniform sampler2D uFrames6;
uniform int uFrameCount;
uniform vec2 uTexel;
uniform float uAngle;
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

vec3 temporalMedian(vec2 uv) {
  vec3 samples[7];
  int n = min(uFrameCount, 7);
  for (int i = 0; i < 7; i++) {
    if (i < n) samples[i] = frameSample(i, uv);
  }
  for (int i = 1; i < 7; i++) {
    if (i >= n) break;
    vec3 key = samples[i];
    float kl = dot(key, vec3(0.299, 0.587, 0.114));
    int j = i - 1;
    for (int k = 0; k < 7; k++) {
      if (j < 0) break;
      float jl = dot(samples[j], vec3(0.299, 0.587, 0.114));
      if (jl <= kl) break;
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = key;
  }
  return samples[n / 2];
}

// 沿雨线垂直方向 nrm 双向步进，找最近的未掩膜像素做距离加权混合。
// 雨线在自身方向连续，垂直方向跨越窄条纹即可取到干净背景。
vec3 spatialInpaint(vec2 uv) {
  vec2 dir = normalize(vec2(sin(uAngle), cos(uAngle)));
  vec2 nrm = vec2(-dir.y, dir.x);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int side = 0; side < 2; side++) {
    float sgn = side == 0 ? 1.0 : -1.0;
    for (int stepi = 1; stepi <= 10; stepi++) {
      vec2 p = uv + nrm * uTexel * (float(stepi) * sgn);
      float mm = texture(uMask, p).a;
      if (mm < 0.25) {
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
  float m = texture(uMask, uv).a;
  vec3 cur = texture(uCurrent, uv).rgb;
  if (m <= 0.01) {
    fragColor = vec4(cur, 0.0);
    return;
  }
  // 纯空间定向修补：沿雨线垂直方向取两侧干净像素，
  // 不依赖时序帧，避免移动车辆/车道产生拖影。
  vec3 repaired = spatialInpaint(uv);
  vec3 outCol = mix(cur, repaired, clamp(m, 0.0, 1.0));
  fragColor = vec4(outCol, m);
}
`;
