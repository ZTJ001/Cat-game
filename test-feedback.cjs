// 按 game-feel skill 的验证步骤做无头检查：
// 1) 两次相隔 30ms 的撞击，只有最新那次拥有解冻权
// 2) 冻结结束后 timeScale 精确回到 1.0
// 3) trauma 在 1/decay 秒内归零，且抖动偏移归零
// 4) 所有缩放 tween 的终点精确等于静止值
// 5) 冻结期间按键仍被记录
// 6) 可访问性档位生效
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/dist/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const noop = () => {};
const listeners = {};
const els = {};

function fakeEl(id) {
  const handlers = {};
  const cls = new Set();
  const el = {
    id,
    textContent: '',
    title: '',
    style: {},
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    },
    addEventListener: (t, f) => { handlers[t] = f; },
    _h: handlers,
    setPointerCapture: noop,
    releasePointerCapture: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    width: 0,
    height: 0,
  };
  els[id] = el;
  return el;
}

const gradient = { addColorStop: noop };
const ctx = new Proxy({ canvas: { width: 0, height: 0 } }, {
  get(t, p) {
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradient;
    if (p === 'measureText') return () => ({ width: 20 });
    if (p in t) return t[p];
    return noop;
  },
  set(t, p, v) { t[p] = v; return true; },
});

const canvas = fakeEl('c');
canvas.getContext = () => ctx;

const store = {};
const sandbox = {
  console,
  document: {
    getElementById: (id) => (id === 'c' ? canvas : (els[id] || fakeEl(id))),
    addEventListener: noop,
  },
  window: {
    devicePixelRatio: 2,
    addEventListener: (t, f) => { listeners[t] = f; },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  },
  location: { search: '' },
  requestAnimationFrame: (cb) => { sandbox.__raf = cb; return 1; },
  setTimeout: () => 0,
  Math,
  Date,
};
sandbox.globalThis = sandbox;

const errors = [];
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'game.js' });
} catch (e) {
  errors.push('初始化异常: ' + e.stack);
}

const raf = sandbox.__raf;
const fb = sandbox.window.__feedback;
if (typeof raf !== 'function') errors.push('未注册 requestAnimationFrame');
if (!fb) errors.push('未暴露 __feedback 回归钩子');

let ts = 1000;
function step(ms) {
  ts += ms;
  try { raf(ts); }
  catch (e) { errors.push('raf@' + Math.round(ts) + ': ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }
}

const fails = [];
function check(name, cond, detail) {
  const tail = detail ? '  [' + detail + ']' : '';
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + tail);
  if (!cond) fails.push(name);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

if (raf && fb) {
  step(0);
  let st = fb.state();
  check('初始状态无残留反馈', st.timeScale === 1 && st.trauma === 0 && st.scaleX === 1, JSON.stringify(st));

  fb.fire('medium');
  st = fb.state();
  check('medium 立即冻结 timeScale=0.06', near(st.timeScale, 0.06, 1e-6), 'timeScale=' + st.timeScale);
  check('medium 冻结时长 0.06s', near(st.hitStopLeft, 0.06, 1e-6), 'left=' + st.hitStopLeft);
  check('压扁姿态立即生效', near(st.scaleX, 1.32, 0.002) && near(st.scaleY, 0.72, 0.002), st.scaleX + '/' + st.scaleY);
  check('trauma 叠加而非重置', near(st.trauma, 0.46, 1e-6), 'trauma=' + st.trauma);

  step(16.7); step(13.3);            // 相隔 30ms 的第二次撞击
  fb.fire('large');
  st = fb.state();
  check('重叠一击取较长冻结 0.12s', near(st.hitStopLeft, 0.12, 0.003), 'left=' + st.hitStopLeft);
  check('重叠一击取更慢 timeScale=0.02', near(st.timeScale, 0.02, 1e-6), 'timeScale=' + st.timeScale);

  const scales = [];
  for (let i = 0; i < 9; i++) { step(16.7); scales.push(fb.state().timeScale); }
  check('冻结期间没有旧定时器提前解冻', scales.slice(0, 6).every((v) => v === 0.02), scales.slice(0, 6).join(','));
  check('冻结结束 timeScale 精确回 1.0', fb.state().timeScale === 1, 'timeScale=' + fb.state().timeScale);

  for (let i = 0; i < 28; i++) step(16.7);
  st = fb.state();
  check('trauma 在 1/decay 内归零', st.trauma === 0, 'trauma=' + st.trauma);
  check('抖动衰减后偏移归零', st.shakeX === 0 && st.shakeY === 0, st.shakeX + '/' + st.shakeY);
  check('squash 终点精确回到 1.0', st.popT === 1 && st.scaleX === 1 && st.scaleY === 1, st.popT + ' ' + st.scaleX + '/' + st.scaleY);
  check('flash 完全消退', st.flash === 0, 'flash=' + st.flash);

  // 冻结期间输入不能被吞掉
  els['btn']._h.click();
  step(16.7);
  const x0 = sandbox.window.__gameState().hero.x;
  listeners.keydown({ key: 'd', preventDefault: noop });
  fb.fire('medium');
  for (let i = 0; i < 5; i++) step(16.7);
  listeners.keyup({ key: 'd' });
  const x1 = sandbox.window.__gameState().hero.x;
  check('顿帧期间按键仍被记录且猫有位移', x1 > x0, x0 + ' -> ' + x1);

  // 可访问性档位
  for (let i = 0; i < 10; i++) step(16.7);
  fb.setFx(2);
  fb.fire('large');
  st = fb.state();
  check('动效关闭时抖动位移为 0', st.shakeX === 0 && st.shakeY === 0 && st.fxLevel === 2);
  for (let i = 0; i < 10; i++) step(16.7);
  fb.setFx(1);
  fb.fire('medium');
  st = fb.state();
  check('减弱模式冻结时长减半', near(st.hitStopLeft, 0.03, 1e-6), 'left=' + st.hitStopLeft);
  check('减弱模式闪光降为淡色 tint', st.flash > 0 && st.flash <= 0.075, 'flash=' + st.flash);
}

console.log('=== 结果 ===');
if (errors.length) {
  console.log('运行时异常 ' + errors.length + ' 个:');
  errors.forEach((e) => console.log(' - ' + e));
}
if (fails.length || errors.length) {
  console.log('失败 ' + fails.length + ' 项 / 异常 ' + errors.length + ' 个');
  process.exitCode = 1;
} else {
  console.log('全部 ' + 18 + ' 项断言通过，无运行时异常。');
}
