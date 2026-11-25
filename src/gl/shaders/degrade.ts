/**
 * 退化合成：在晴天 GT 帧上叠加三类雨天退化，全部基于确定性 hash，
 * 因此同一 (uTime, 种子) 可重复生成。雨线方向、雨量、水珠密度可调。
 */
export const DEGRADE_FRAG = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uTime;
uniform float uRain;         // 雨量 0..1
uniform float uAngle;        // 雨线与竖直方向夹角（弧度）
uniform float uDroplets;     // 水珠密度 0..1
uniform float uGlare;        // 光晕强度 0..1
uniform float uSeed;
out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  return vec2(hash12(p), hash12(p + vec2(19.19, 7.71)));
}

// 一条沿 angle 方向的细长亮线：在垂直雨线方向做窄核、沿线方向做长核
float rainStreak(vec2 uv, float t) {
  vec2 dir = normalize(vec2(sin(uAngle), cos(uAngle)));   // 雨线方向
  vec2 nrm = vec2(-dir.y, dir.x);                         // 垂直方向
  // 屏幕空间按分辨率换算，保证 1080p 下细而长
  vec2 px = uv * uResolution;
  float along = dot(px, dir);
  float perp = dot(px, nrm);

  float acc = 0.0;
  // 雨线数量随雨量：每 1080p 画面约 90~420 条
  float count = mix(60.0, 420.0, uRain);
  // 分层网格，避免双重循环
  vec2 grid = vec2(46.0, 46.0);
  vec2 cell = floor(vec2(along / grid.x, perp / grid.y));
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 c = cell + vec2(ox, oy);
      vec2 rnd = hash22(c + uSeed);
      // 每条雨线的随机位置/长度/速度/亮度
      float spawn = step(1.0 - uRain * 0.92, hash12(c + rnd + uSeed));
      vec2 center = (c + rnd) * grid;
      float len = mix(38.0, 110.0, hash12(c + 3.3)) * (0.7 + uRain * 0.6);
      float speed = mix(900.0, 1500.0, hash12(c + 9.1));
      float travel = mod(t * speed + rnd.x * len * 4.0, uResolution.y * 1.6);
      center += dir * travel;
      float dAlong = along - center.x;
      float dPerp = perp - center.y;
      // 沿线：软长度核；垂直线：1.2~2px 高斯核
      float coreA = exp(-(dAlong * dAlong) / (len * len));
      float coreP = exp(-(dPerp * dPerp) / (1.6 * 1.6));
      float bright = mix(0.25, 0.75, hash12(c + 5.5));
      acc += spawn * coreA * coreP * bright;
    }
  }
  return clamp(acc, 0.0, 1.0);
}

// 镜头水珠：位置静止的圆形折射斑。位置由固定网格+hash决定，不随时间移动。
// 返回 (覆盖率, 折射偏移量)
vec4 dropletField(vec2 uv) {
  vec2 px = uv * uResolution;
  float acc = 0.0;
  vec2 shift = vec2(0.0);
  float gridSize = mix(150.0, 85.0, uDroplets);
  vec2 cell = floor(px / gridSize);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 c = cell + vec2(ox, oy);
      vec2 rnd = hash22(c + 17.0 + uSeed);
      float alive = step(1.0 - uDroplets * 0.8, hash12(c + 2.1 + uSeed));
      vec2 center = (c + rnd) * gridSize;
      float radius = mix(10.0, 34.0, hash12(c + 8.8));
      float d = length(px - center);
      if (d < radius) {
        float nd = d / radius;
        // 球面折射：中心偏移小、边缘偏移大，方向沿径向
        vec2 radial = (px - center) / max(d, 0.001);
        float lens = sin(nd * 3.14159) * radius * 0.35;
        // 覆盖软边 + 暗环（水珠边缘全反射）
        float cover = smoothstep(1.0, 0.85, nd) * alive;
        float rim = smoothstep(0.75, 1.0, nd) * 0.35 * alive;
        acc = max(acc, cover);
        shift += radial * lens * cover;
        acc += rim;
      }
    }
  }
  return vec4(clamp(acc, 0.0, 1.0), shift, 0.0);
}

// 车灯光晕：在高光（尾灯/大灯/反光）周围做径向辉光，雨夜尤其明显
vec3 applyGlare(vec3 col, vec2 uv, vec3 sceneCol) {
  // 高亮阈值掩膜
  float lum = dot(sceneCol, vec3(0.299, 0.587, 0.114));
  float hot = smoothstep(0.72, 0.95, lum);
  if (hot <= 0.001) return col;
  // 小核辉光（3 次加宽采样）
  vec2 px = 1.0 / uResolution;
  vec3 glow = vec3(0.0);
  const int R = 3;
  for (int y = -R; y <= R; y++) {
    for (int x = -R; x <= R; x++) {
      vec2 off = vec2(x, y) * px * 6.0;
      vec3 s = texture(uScene, uv + off).rgb;
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      float w = exp(-float(x * x + y * y) / 6.0);
      glow += s * smoothstep(0.6, 0.9, l) * w;
    }
  }
  glow /= 20.0;
  // 偏暖白的雨夜车灯光
  vec3 warm = glow * vec3(1.0, 0.92, 0.78);
  return col + warm * uGlare * 0.85;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 dp = dropletField(uv);
  float cover = dp.r;
  vec2 refrShift = dp.gb / uResolution;

  // 水珠折射：从偏移位置采样场景（放大变形），并叠暗环
  vec3 refracted = texture(uScene, clamp(uv + refrShift, vec2(0.001), vec2(0.999))).rgb;
  vec3 scene = texture(uScene, uv).rgb;
  vec3 col = mix(scene, refracted, cover);
  // 水珠内部轻微模糊感：混入小范围均值
  vec2 px = 1.0 / uResolution;
  vec3 blur = vec3(0.0);
  blur += texture(uScene, uv + vec2(px.x, 0.0)).rgb;
  blur += texture(uScene, uv - vec2(px.x, 0.0)).rgb;
  blur += texture(uScene, uv + vec2(0.0, px.y)).rgb;
  blur += texture(uScene, uv - vec2(0.0, px.y)).rgb;
  col = mix(col, blur * 0.25, cover * 0.35);
  col *= 1.0 - cover * 0.12;

  // 雨线：加性亮条纹，带轻微运动透明感
  float streak = rainStreak(uv, uTime);
  col += streak * vec3(0.75, 0.8, 0.9) * (0.55 + uRain * 0.45);

  // 雨夜整体雾化（低对比、偏冷）
  float fogAmt = 0.12 * uRain + 0.08 * cover;
  col = mix(col, vec3(0.45, 0.5, 0.58), fogAmt);

  // 车灯光晕
  col = applyGlare(col, uv, texture(uScene, uv).rgb);

  // 传感器噪声
  float n = (hash12(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.02;
  col += n;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/**
 * 车牌区域掩膜：与场景 shader 完全一致的车辆/车牌几何，
 * 输出 R=车牌区域（含字符槽位编号 G），供 CPU 回读后做识别率统计。
 * 为保持几何一致，这里复制场景中的投影常量。
 */
export const PLATE_MASK_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uResolution;
out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
const float CAM_H = 8.0;
const float HORIZON = 0.38;
const float TAN_MAX = 1.25;

void main() {
  // 视觉坐标（顶部=0），与 scene.frag 的几何约定一致
  vec2 nuv = gl_FragCoord.xy / uResolution;
  vec2 frag = vec2(nuv.x, 1.0 - nuv.y);
  if (frag.y < HORIZON) {
    fragColor = vec4(0.0);
    return;
  }

  float mask = 0.0;
  float charSlot = -1.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float lane = mod(fi, 3.0);
    float cycle = 48.0 + fi * 7.0;
    float phase = fract(uTime / cycle + hash11(fi * 3.1));
    float zNear = fi < 0.5 ? 40.0 : 110.0;
    float z = mix(zNear, 15.0, phase);
    float s = 1.0 / z;
    float tanTheta = CAM_H / z;
    float tt = tanTheta / TAN_MAX;
    float screenY = HORIZON + tt * (1.0 - HORIZON);
    float carW = 1.8 * s;
    float carH = 1.5 * s;
    float laneX = (lane - 1.0) * 3.0;
    float centerX = 0.5 + laneX * s;
    float bottomY = screenY;
    vec2 pMin = vec2(centerX - carW * 0.2, bottomY + carH * 0.2);
    vec2 pMax = vec2(centerX + carW * 0.2, bottomY + carH * 0.33);
    if (frag.x >= pMin.x && frag.x <= pMax.x && frag.y >= pMin.y && frag.y <= pMax.y) {
      mask = 1.0;
      charSlot = floor((frag.x - pMin.x) / (pMax.x - pMin.x) * 7.0);
    }
  }
  fragColor = vec4(mask, charSlot, 0.0, 1.0);
}
`;
