/**
 * 合成器着色器：
 *  - scene.frag 程序化晴天高速监控场景（含可用于指标统计的车牌）
 *  - degrade.frag 在晴天帧上叠加雨线 / 镜头水珠折射 / 车灯光晕
 * 两者共用完全相同的场景参数，保证晴天帧即真值（GT）。
 */

export const SCENE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uResolution;
uniform sampler2D uFontTex;   // 5x7 字形图集，R 通道
uniform vec4 uFontInfo;       // (cols, rows, cellW, cellH)

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 道路透视。视觉坐标 fv：屏幕顶部=0、底部=1（由原生 gl_FragCoord.y 翻转得到）。
// 灭点 HORIZON=0.38；t=灭点向下比例 0..1；tan(theta)=t*TAN_MAX。
const float CAM_H = 8.0;
const float HORIZON = 0.38;
const float ROAD_HALF_W = 9.0;
const float TAN_MAX = 1.25;            // 画面底边俯视角 ~51°

float tFromV(float fv) {
  return clamp((fv - HORIZON) / (1.0 - HORIZON), 0.0, 1.0);
}

float depthFromY(float fv) {
  float t = tFromV(fv);
  return CAM_H / max(t * TAN_MAX, 0.012);
}

// 给定深度 z 处的透视屏幕尺度（世界米 -> 归一化屏幕比例）。
float perspAtZ(float z) {
  return 1.0 / z;
}

// 车辆定义：x=横向偏移(米, 右为正), z=深度, 速度, 车道, 颜色rgb, 车牌字符索引[7]
struct Car {
  float x;
  float z;
  float speed;
  float lane;
  vec3 color;
  vec4 plate1;
  vec4 plate2;
};

// 蓝底白字车牌（简化省名+字母数字共7位），字符取自图集
vec4 sampleFont(vec2 uv, int charIdx) {
  float cols = uFontInfo.x;
  float rows = uFontInfo.y;
  float cw = uFontInfo.z;
  float ch = uFontInfo.w;
  float col = mod(float(charIdx), cols);
  float row = floor(float(charIdx) / cols);
  // 单元内坐标 -> 图集像素 -> 归一化 UV（必须除以图集总尺寸）
  vec2 px = vec2(col * cw, row * ch) + vec2(uv.x * cw, uv.y * ch);
  return texture(uFontTex, px / vec2(cols * cw, rows * ch));
}

vec3 drawPlate(vec3 base, vec2 plateUv, vec4 p1, vec4 p2) {
  if (plateUv.x < 0.0 || plateUv.x > 1.0 || plateUv.y < 0.0 || plateUv.y > 1.0) return base;
  // 蓝底渐变
  vec3 col = mix(vec3(0.05, 0.18, 0.55), vec3(0.08, 0.24, 0.65), plateUv.y);
  // 细白边（只占 3%，避免吃掉字符区域）
  float border = step(plateUv.x, 0.03) + step(0.97, plateUv.x)
               + step(plateUv.y, 0.08) + step(0.92, plateUv.y);
  col = mix(col, vec3(0.95), clamp(border, 0.0, 1.0) * 0.9);
  // 7 个字符槽，字符纵向占满 84% 高度
  float slot = plateUv.x * 7.0;
  int ci = int(floor(slot));
  float fu = fract(slot);
  vec4 indices = ci < 4 ? p1 : p2;
  int localIdx = ci - (ci < 4 ? 0 : 4);
  int glyph = localIdx == 0 ? int(indices.x)
           : localIdx == 1 ? int(indices.y)
           : localIdx == 2 ? int(indices.z) : int(indices.w);
  float gv = sampleFont(vec2(fu * 0.9 + 0.05, plateUv.y * 0.84 + 0.08), glyph).r;
  col = mix(col, vec3(0.97, 0.97, 1.0), smoothstep(0.3, 0.55, gv));
  return col;
}

// 在屏幕上画一辆朝镜头行驶的车（尾部朝向观察者）
vec3 renderCar(vec3 col, Car car, vec2 frag, inout float plateMask, inout vec2 plateUvOut) {
  float z = car.z;
  float s = perspAtZ(z);                  // 世界米 -> 屏幕比例
  // 由深度反推屏幕垂直位置，与 depthFromY 互为逆运算，保证车轮贴在路面上
  float tanTheta = CAM_H / z;
  float t = tanTheta / TAN_MAX;
  // 视觉坐标下灭点向下，screenY = HORIZON + t*(1-HORIZON)
  float screenY = HORIZON + t * (1.0 - HORIZON);
  // 车身宽 1.8m、高 1.5m（世界坐标），按透视尺度投影
  float carW = 1.8 * s;
  float carH = 1.5 * s;
  float centerX = 0.5 + car.x * s;
  float bottomY = screenY;
  float topY = screenY + carH;
  vec2 cmin = vec2(centerX - carW * 0.5, bottomY);
  vec2 cmax = vec2(centerX + carW * 0.5, topY);
  if (frag.x < cmin.x || frag.x > cmax.x || frag.y < cmin.y || frag.y > cmax.y) {
    return col;
  }
  vec2 uv = (frag - cmin) / (cmax - cmin);
  vec3 body = car.color;
  // 车顶/车窗：上 35% 深色玻璃
  float glass = smoothstep(0.35, 0.42, 1.0 - uv.y);
  body = mix(body, vec3(0.08, 0.1, 0.13), glass * 0.85);
  // 车身明暗（两侧略暗，模拟弧面）
  body *= 0.75 + 0.35 * sin(uv.x * 3.14159);
  // 尾灯：底部左右两个红块
  float tailL = step(0.08, uv.x) * step(uv.x, 0.22) * step(uv.y, 0.16);
  float tailR = step(0.78, uv.x) * step(uv.x, 0.92) * step(uv.y, 0.16);
  body = mix(body, vec3(0.9, 0.08, 0.05), clamp(tailL + tailR, 0.0, 1.0));
  // 车牌：车尾中部偏下，宽占车身 40%，高占 13%
  vec2 pMin = vec2(centerX - carW * 0.2, bottomY + carH * 0.2);
  vec2 pMax = vec2(centerX + carW * 0.2, bottomY + carH * 0.33);
  if (frag.x >= pMin.x && frag.x <= pMax.x && frag.y >= pMin.y && frag.y <= pMax.y) {
    vec2 puv = (frag - pMin) / (pMax - pMin);
    body = drawPlate(body, puv, car.plate1, car.plate2);
    plateMask = 1.0;
    plateUvOut = puv;
  }
  return body;
}

void main() {
  // 原生 GL 坐标（纹理采样用，底部=0）与视觉坐标（几何用，顶部=0）分离
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 frag = vec2(uv.x, 1.0 - uv.y);
  float z = depthFromY(frag.y);

  // ---------- 天空 / 远景 ----------
  vec3 sky = mix(vec3(0.42, 0.52, 0.62), vec3(0.72, 0.76, 0.8), frag.y);
  // 远处山影
  float ridge = HORIZON - 0.05 - 0.035 * noise2(vec2(frag.x * 6.0, 1.7));
  vec3 col = frag.y > ridge ? sky : vec3(0.28, 0.36, 0.28);
  if (frag.y < HORIZON) {
    // 远山之上的天空加一点云
    float cloud = smoothstep(0.55, 0.8, noise2(frag * vec2(3.0, 5.0) + vec2(uTime * 0.01, 0.0)));
    col = mix(col, vec3(0.85, 0.86, 0.88), cloud * 0.4 * step(ridge, frag.y));
    fragColor = vec4(col, 1.0);
    return;
  }

  // ---------- 路面 ----------
  // 当前屏幕行的透视尺度：世界米 -> 屏幕比例。
  // 地面点 tan(theta)=t*TAN_MAX=CAM_H/z，故 1/z=t*TAN_MAX/CAM_H，
  // 世界横向 X 米的屏幕比例 = X/z = X*t*TAN_MAX/CAM_H。
  float t = (frag.y - HORIZON) / (1.0 - HORIZON);
  float persp = t * TAN_MAX / CAM_H;
  float halfRoad = ROAD_HALF_W * persp;
  float roadL = 0.5 - halfRoad;
  float roadR = 0.5 + halfRoad;
  vec3 asphalt = vec3(0.16, 0.16, 0.17) + 0.02 * noise2(frag * vec2(uResolution.x * 0.5, uResolution.y * 0.5));
  // 路面横向细微纹理随速度流动
  asphalt += 0.015 * noise2(vec2(frag.x * 80.0, frag.y * 300.0 - uTime * 8.0));
  if (frag.x > roadL && frag.x < roadR) {
    col = asphalt;
  } else {
    // 路肩草地/护坡
    vec3 grass = vec3(0.18, 0.26, 0.14) + 0.04 * noise2(frag * 40.0);
    col = grass;
  }
  // 道路边界：仅当路缘位于屏幕内时画细路缘线；
  // 近景道路已铺满画面（roadL<0 / roadR>1），不能再画，否则会形成横向亮带
  float edgeLine = 0.0;
  if (roadL > 0.0 && roadR < 1.0) {
    float edgeD = min(abs(frag.x - roadL), abs(frag.x - roadR));
    edgeLine = 1.0 - smoothstep(0.0008, 0.0025, edgeD);
  }
  col = mix(col, vec3(0.62, 0.62, 0.58), edgeLine * 0.9);

  // 车道线：3 条车道 -> 4 条线，外侧实线、内侧虚线
  float laneW = (halfRoad * 2.0) / 3.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float lx = roadL + laneW * fi;
    float lw = max(0.0012, 0.0035 * t);
    if (abs(frag.x - lx) < lw) {
      bool dashed = (i == 1 || i == 2);
      if (!dashed) {
        col = vec3(0.82, 0.82, 0.78);
      } else {
        // 虚线：世界坐标周期性虚实段，随车流速度向下流动
        float phase = fract((z - uTime * 18.0) / 15.0);
        if (phase < 0.45) col = vec3(0.85, 0.85, 0.8);
      }
    }
  }

  // ---------- 车辆（5 辆，确定性参数，循环行驶） ----------
  Car cars[5];
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float lane = mod(fi, 3.0);
    float cycle = 48.0 + fi * 7.0;
    float phase = fract(uTime / cycle + hash11(fi * 3.1));
    // 0 号车固定在中近距离循环，保证任意时刻都有可评估的大车牌
    float zNear = fi < 0.5 ? 40.0 : 110.0;
    float zz = mix(zNear, 15.0, phase);
    float laneX = (lane - 1.0) * 3.0;
    vec3 cc = vec3(hash11(fi * 7.7), hash11(fi * 13.3), hash11(fi * 21.9));
    cc = 0.25 + cc * 0.55;
    // 确定性车牌（图集索引 0..35：0-9 数字、10-35 字母）
    vec4 p1 = vec4(10.0 + mod(fi * 5.0, 26.0), mod(fi * 3.0, 10.0),
                   mod(fi * 7.0 + 2.0, 10.0), 10.0 + mod(fi * 11.0, 26.0));
    vec4 p2 = vec4(mod(fi * 13.0 + 1.0, 10.0), mod(fi * 17.0 + 4.0, 10.0),
                   mod(fi * 19.0 + 7.0, 10.0), 0.0);
    cars[i] = Car(laneX, zz, 0.0, lane, cc, p1, p2);
  }

  float plateMask = 0.0;
  vec2 plateUv = vec2(-1.0);
  // 从远到近画，近的覆盖远的
  for (int j = 4; j >= 0; j--) {
    col = renderCar(col, cars[j], frag, plateMask, plateUv);
  }

  // 大气透视：远处轻微泛灰
  float fog = smoothstep(60.0, 140.0, z) * 0.35;
  col = mix(col, vec3(0.6, 0.64, 0.68), fog);

  fragColor = vec4(col, 1.0);
}
`;
