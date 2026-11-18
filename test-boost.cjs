// 逗猫棒 / 限时增益的无头回归：
// 随机投放的位置必须可达、间隔与存活时长随机、速度真的翻倍、
// 10 秒后恢复、重复拾取只刷新时长不叠倍率、未拾取会超时消失。
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
const boost = sandbox.window.__boost;
const fb = sandbox.window.__feedback;
const gameState = sandbox.window.__gameState;
if (typeof raf !== 'function') errors.push('未注册 requestAnimationFrame');
if (!boost) errors.push('未暴露 __boost 回归钩子');

let ts = 1000;
function step(ms) {
  ts += ms;
  try { raf(ts); }
  catch (e) { errors.push('raf@' + Math.round(ts) + ': ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }
}
// 用确定性时钟推进：静止的猫会被机器人撞到，hit-stop 会压慢主循环的模拟时间
const advance = (seconds) => boost.tick(seconds);

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  const tail = detail ? '  [' + detail + ']' : '';
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + tail);
  if (cond) passed++; else fails.push(name);
}

if (raf && boost) {
  step(0);
  boost.restart();
  step(16.7);

  let st = boost.state();
  check('开局无增益、场上有待投放计时', st.boostLeft === 0 && st.multiplier === 1 && !st.active);
  check('首次投放随机落在 8~15 秒', st.nextIn >= 8 && st.nextIn <= 15, 'nextIn=' + st.nextIn);

  // 多次采样：位置随机且都落在猫能走到的地方
  const spots = [];
  let valid = 0;
  for (let k = 0; k < 12; k++) {
    boost.spawn();
    const q = boost.state();
    if (!q.active) continue;
    spots.push(q.x + ',' + q.y);
    if (q.reachable && q.awayFromCat >= 150 && q.ttl === 9) valid++;
  }
  check('12 次投放位置均可达、离猫 >=150px、存活 9s', valid >= 11, valid + '/12');
  check('位置确实随机不同', new Set(spots).size >= 10, new Set(spots).size + ' 个不同坐标');

  boost.spawn();
  boost.pick();
  st = boost.state();
  check('碰上后速度 ×2 且持续 10 秒', st.multiplier === 2 && st.boostLeft === 10, JSON.stringify({ m: st.multiplier, left: st.boostLeft }));
  check('拾取后消失并重新随机排期 12~25s', !st.active && st.nextIn >= 12 && st.nextIn <= 25, 'nextIn=' + st.nextIn);
  check('拾取不该产生顿帧', fb.state().timeScale === 1 && fb.state().hitStopLeft === 0);
  check('拾取有飘字提示', st.pops >= 1, 'pops=' + st.pops);

  // 主循环本身也在推进增益计时，不是只有测试钩子会动
  const beforeLoop = boost.state().boostLeft;
  for (let i = 0; i < 30; i++) step(16.7);
  const afterLoop = boost.state().boostLeft;
  check('主循环每帧推进增益计时', afterLoop < beforeLoop && afterLoop > beforeLoop - 0.8,
        beforeLoop + ' -> ' + afterLoop);

  advance(10.2);
  st = boost.state();
  check('10 秒后增益结束、倍率回 1', st.boostLeft === 0 && st.multiplier === 1, JSON.stringify({ left: st.boostLeft, m: st.multiplier }));

  boost.spawn(); boost.pick();
  advance(4);
  const mid = boost.state();
  boost.spawn(); boost.pick();
  st = boost.state();
  check('重复拾取把时长刷新回 10 秒', st.boostLeft === 10, 'left=' + st.boostLeft);
  check('倍率不叠加，仍是 ×2', mid.multiplier === 2 && st.multiplier === 2);

  boost.spawn();
  advance(9.4);
  st = boost.state();
  check('9 秒没接住就自动消失', !st.active, 'active=' + st.active);

  // 实际位移对比：两次干净开局，同样按 15 帧右键
  function measure(withBoost) {
    boost.restart();
    step(16.7);
    if (withBoost) { boost.spawn(); boost.pick(); step(16.7); }
    const x0 = gameState().hero.x;
    listeners.keydown({ key: 'd', preventDefault: noop });
    for (let i = 0; i < 15; i++) step(16.7);
    listeners.keyup({ key: 'd' });
    return gameState().hero.x - x0;
  }
  const d1 = measure(false);
  const d2 = measure(true);
  check('实际位移约为两倍', d1 > 0 && Math.abs(d2 / d1 - 2) < 0.08, d1.toFixed(2) + 'px -> ' + d2.toFixed(2) + 'px');

  // 自动试玩能读到道具与增益状态
  const gs = gameState();
  check('试玩协议能读到 feather / boost 字段', 'feather' in gs && 'boost' in gs);
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
  console.log('全部 ' + passed + ' 项断言通过，无运行时异常。');
}
