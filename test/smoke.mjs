/**
 * 无头冒烟测试：系统 Chrome + SwiftShader 软件 WebGL2。
 * 交互全部在浏览器内用 JS 触发，避免软件渲染长帧导致 Playwright 动作超时。
 * 用法：npm run build 后 node test/smoke.mjs
 */
import { preview } from 'vite';
import { chromium } from 'playwright';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const server = await preview({
  root: process.cwd(),
  preview: { port: 5199, strictPort: true },
  logLevel: 'error',
});
const port = server.config?.preview?.port ?? 5199;
console.log(`[smoke] preview on http://127.0.0.1:${port}`);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)));

const clickTab = (name) => page.evaluate((n) => {
  document.querySelector(`.tab[data-tab="${n}"]`)?.click();
}, name);
const clickId = (id) => page.evaluate((i) => document.getElementById(i)?.click(), id);

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__rainGuard, { timeout: 10000 });
  // 软件渲染降分辨率，加速帧积累
  await page.evaluate(() => window.__rainGuard.setWorkSize(854, 480));
  // 等待时序累积与指标统计（指标每 12 帧一次）
  await page.waitForFunction(
    () => {
      const t = document.getElementById('mPsnrOut')?.textContent ?? '';
      return t.includes('dB') && !t.startsWith('0.00');
    },
    { timeout: 40000 },
  );
  await page.waitForTimeout(3000);

  const metrics = await page.evaluate(() => {
    const get = (id) => document.getElementById(id)?.textContent ?? null;
    // 复现 platesAt 几何，打印所有车辆的车牌屏幕尺寸
    const CAM_H = 8, HORIZON = 0.38, TAN_MAX = 1.25;
    const W = 854, H = 480;
    const fract = (v) => v - Math.floor(v);
    const hash11 = (p) => { const x = fract(p * 0.1031); return fract(x * (x + 33.33) * (x * (x + 33.33))); };
    const time = parseFloat((get('timeLabel') ?? '0').replace(/[^0-9.]/g, '')) || 0;
    const geom = [];
    for (let i = 0; i < 5; i++) {
      const lane = i % 3;
      const cycle = 48 + i * 7;
      const phase = fract(time / cycle + hash11(i * 3.1));
      const zNear = i === 0 ? 40 : 110;
      const z = zNear + (15 - zNear) * phase;
      const s = 1 / z;
      const carW = 1.8 * s, carH = 1.5 * s;
      const laneX = (lane - 1) * 3;
      const centerX = 0.5 + laneX * s;
      const screenY = HORIZON + (CAM_H / z / TAN_MAX) * (1 - HORIZON);
      const pw = carW * 0.4 * W, ph = carH * 0.13 * H;
      geom.push({ i, z: z.toFixed(1), plateW: pw.toFixed(1), plateH: ph.toFixed(1), centerX: centerX.toFixed(2), screenY: screenY.toFixed(2) });
    }
    return {
      psnrIn: get('mPsnrIn'), psnrOut: get('mPsnrOut'), psnrGain: get('mPsnrGain'),
      fps: get('mFps'), frameMs: get('mMs'),
      plateIn: get('mPlateIn'), plateOut: get('mPlateOut'), plateRatio: get('mPlateRatio'),
      res: get('resPill'), status: get('statusPill'),
      plateDbg: globalThis.__plateDbg ?? null, geom, simTime: time,
    };
  });

  const shots = {};
  for (const tab of ['source', 'preview', 'droplet', 'record']) {
    await clickTab(tab);
    await page.waitForTimeout(500);
    const path = `test/shot-${tab}.png`;
    await page.screenshot({ path });
    shots[tab] = path;
  }

  // 交互冒烟（JS 触发）
  await clickTab('preview');
  await page.evaluate(() => { document.getElementById('chkMask').click(); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test/shot-mask-vis.png' });
  await page.evaluate(() => { document.getElementById('chkMask').click(); });
  await clickId('btnResetTemporal');
  await page.waitForTimeout(600);
  await clickTab('droplet');
  await clickId('btnAddMark');
  await page.evaluate(() => {
    const c = document.getElementById('dropCanvas');
    const r = c.getBoundingClientRect();
    const mk = (type, x, y) => c.dispatchEvent(new MouseEvent(type, {
      clientX: r.left + x, clientY: r.top + y, bubbles: true,
    }));
    mk('mousedown', r.width * 0.4, r.height * 0.4);
    mk('mousemove', r.width * 0.48, r.height * 0.48);
    mk('mouseup', r.width * 0.48, r.height * 0.48);
  });
  await page.waitForTimeout(400);
  const markCount = await page.locator('#markList li').count();

  console.log('[smoke] metrics:', JSON.stringify(metrics, null, 2));
  console.log('[smoke] screenshots:', JSON.stringify(shots));
  console.log(`[smoke] mark entries: ${markCount}`);
  console.log(`[smoke] console errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  CONSOLE:', e));
  console.log(`[smoke] page errors: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach((e) => console.log('  PAGE:', e));

  const fatal = [...consoleErrors, ...pageErrors].filter((e) =>
    /Shader|Program|WebGL|GL_|framebuffer|initialize|初始化|编译|链接/i.test(e),
  );
  if (fatal.length > 0) {
    console.error('[smoke] FAIL: GPU/着色器错误');
    process.exitCode = 2;
  } else {
    console.log('[smoke] PASS: 无 GPU/着色器错误');
  }
} catch (err) {
  console.error('[smoke] FAIL:', err);
  await page.screenshot({ path: 'test/shot-fail.png' }).catch(() => {});
  console.log('console errors:', consoleErrors);
  console.log('page errors:', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
