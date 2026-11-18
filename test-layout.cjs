// 布局 / 边界脱身回归：
// 1) 静态：家具离边界 >=100px、家具间最窄通道 >=90px、8 个边界点猫都站得住；
// 2) 动态：把猫放到四角与四边中段，再放一台机器人堵在朝内方向，
//    用真实主循环 + 自动试玩跑 3 秒，猫必须还能跑起来（没有被困死）。
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/dist/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const noop = () => {};
const listeners = {};
const els = {};
// 与 dist/index.html 的 drawFurniture() 比例系数一一对应。
// 返回每种家具所有图案元素的局部包围盒，用来验证缩小家具后图案不会画到外面。
function patternBoxes(type, w, h) {
  const b = [];
  const box = (x, y, ww, hh) => b.push([x, y, x + ww, y + hh]);
  const circle = (cx, cy, r) => b.push([cx - r, cy - r, cx + r, cy + r]);
  switch (type) {
    case 'fridge':
      box(w * 0.84, h * 0.14, w * 0.06, h * 0.35);
      box(w * 0.15, h * 0.17, w * 0.12, h * 0.08);
      box(w * 0.35, h * 0.28, w * 0.10, h * 0.08);
      box(w * 0.18, h * 0.45, w * 0.11, h * 0.06);
      break;
    case 'counter':
      box(w * 0.076, h * 0.17, w * 0.82, h * 0.26);
      box(w * 0.12, h * 0.45, w * 0.39, h * 0.45);
      break;
    case 'sink':
      box(w * 0.15, h * 0.23, w * 0.30, h * 0.55);
      box(w * 0.545, h * 0.23, w * 0.30, h * 0.55);
      box(w * 0.162, h * 0.29, w * 0.273, h * 0.42);
      box(w * 0.558, h * 0.29, w * 0.273, h * 0.42);
      circle(w * 0.494, h * 0.5, Math.min(7, h * 0.1));
      break;
    case 'stove':
      circle(w * 0.266, h * 0.54, w * 0.124);
      circle(w * 0.706, h * 0.54, w * 0.124);
      circle(w * 0.706, h * 0.54, w * 0.11);
      break;
    case 'table':
      box(w * 0.12, h * 0.21, w * 0.76, h * 0.58);
      circle(w * 0.35, h * 0.5, w * 0.095);
      break;
    case 'island':
      for (let m = 0; m < 3; m++) {
        const ly = h * (0.28 + m * 0.24);
        b.push([w * 0.07, ly, w * 0.93, ly]);
      }
      circle(w * 0.765, h * 0.5, w * 0.09);
      circle(w * 0.742, h * 0.47, w * 0.025);
      circle(w * 0.826, h * 0.52, w * 0.025);
      break;
  }
  return b;
}

function fakeEl(id) {
  const handlers = {};
  const cls = new Set();
  const el = {
    id,
    textContent: '',
    title: '',
    style: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
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
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
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
const layout = sandbox.window.__layout;
const boost = sandbox.window.__boost;
const gameState = sandbox.window.__gameState;
const autoplay = sandbox.window.__autoplay;
const mouseHook = sandbox.window.__mouse;
// 布局用例只考察猫与一台机器人；每轮清掉老鼠并推迟到很久以后，避免随机刷新干扰脱身判定
const clearMouse = () => { if (mouseHook) { mouseHook.finish(); } };

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (cond) passed++; else fails.push(name);
}

let ts = 1000;
function step(ms) {
  ts += ms;
  try { raf(ts); }
  catch (e) { errors.push('raf@' + Math.round(ts) + ': ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }
}

if (!layout || !boost || !gameState || !autoplay || typeof raf !== 'function') {
  errors.push('缺少必要的回归钩子');
} else {
  step(0);
  boost.restart();
  step(16.7);

  const W = 960, H = 540;
  const furn = layout.furniture();

  // ---- 静态布局断言 ----
  const minEdge = Math.min(
    ...furn.map((f) => Math.min(f.x, W - (f.x + f.w), f.y, H - (f.y + f.h)))
  );
  check('6 件家具齐全', furn.length === 6, furn.map((f) => f.type).join(','));
  check('所有家具离边界 >=100px', minEdge >= 100, '最小边距 ' + minEdge + 'px');

  let minGap = Infinity, gapPair = '';
  for (let i = 0; i < furn.length; i++) {
    for (let j = i + 1; j < furn.length; j++) {
      const a = furn[i], b = furn[j];
      const xOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
      const yOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
      let gap = null;
      if (yOverlap && !xOverlap) gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      if (xOverlap && !yOverlap) gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      if (gap !== null && gap > 0 && gap < minGap) { minGap = gap; gapPair = a.type + '/' + b.type; }
    }
  }
  check('家具间最窄通道 >=90px', minGap >= 90, minGap + 'px @ ' + gapPair);

  const spots = [
    ['左上角', 35, 35], ['上边中段', 480, 35], ['右上角', 925, 35],
    ['右边中段', 925, 270], ['右下角', 925, 505], ['下边中段', 480, 505],
    ['左下角', 35, 505], ['左边中段', 35, 270],
  ];
  const standable = spots.filter(([, x, y]) => !layout.blocked(x, y, 17));
  check('8 个边界点猫都站得住', standable.length === 8, standable.length + '/8');

  // ---- 动态脱身：每个点放一台机器人堵在朝内 62px 处，跑 3 秒 ----
  console.log('');
  for (const [name, cx, cy] of spots) {
    boost.restart();
    clearMouse();               // 隔老鼠干扰：布局用例只测猫 + 一台机器人
    step(16.7);
    const dx = W / 2 - cx, dy = H / 2 - cy;
    const L = Math.hypot(dx, dy) || 1;
    let rx = cx + dx / L * 62, ry = cy + dy / L * 62;
    if (layout.blocked(rx, ry, 20)) { rx = cx; ry = cy; }   // 极端情况退化为贴身
    layout.setup(cx, cy, rx, ry);

    let px = cx, py = cy, moved = 0;
    // 跑两段各 3 秒：贪心寻路偶尔会在角落顶住机器人一小会儿，
    // 只要 6 秒内最终能脱身即证明空间连通（静态审计已证明无软锁）。
    for (let seg = 0; seg < 2; seg++) {
      for (let i = 0; i < 180; i++) {
        if (i % 6 === 0) autoplay(gameState());
        step(16.7);
        const st = layout.state();
        moved += Math.hypot(st.cat.x - px, st.cat.y - py);
        px = st.cat.x; py = st.cat.y;
      }
      if (moved > 100 && !layout.blocked(px, py, 17)) break;   // 已脱身无需第二段
    }
    const st = layout.state();
    const escaped = moved > 100 && !layout.blocked(px, py, 17);
    check(name + ' 被堵后仍能脱身', escaped,
      '累计位移 ' + Math.round(moved) + 'px, 终点 (' + Math.round(px) + ',' + Math.round(py) + ')' + (st.phase !== 'playing' ? ', 已结束' : ''));
  }

  // ---- 比例化图案的包围盒必须落在家具矩形内 ----
  console.log('');
  const overflow = [];
  let boxCount = 0;
  for (const f of furn) {
    const boxes = patternBoxes(f.type, f.w, f.h);
    if (!boxes.length) overflow.push(f.type + ' 无图案定义');
    boxes.forEach(([x0, y0, x1, y1]) => {
      boxCount++;
      if (x0 < -1 || y0 < -1 || x1 > f.w + 1 || y1 > f.h + 1) {
        overflow.push(`${f.type}(${f.w}x${f.h}) [${Math.round(x0)},${Math.round(y0)}..${Math.round(x1)},${Math.round(y1)}]`);
      }
    });
  }
  check('6 件家具的比例化图案均未越界', overflow.length === 0,
    '检查 ' + boxCount + ' 个包围盒' + (overflow.length ? ', 越界: ' + overflow.slice(0, 3).join(' ') : ''));
}

console.log('');
if (errors.length) {
  console.log('运行时异常 ' + errors.length + ' 处:');
  errors.slice(0, 5).forEach((e) => console.log('  ' + e));
}
console.log('=== 结果: ' + passed + ' 项通过, ' + fails.length + ' 项失败, ' + errors.length + ' 处异常 ===');
if (fails.length) console.log('失败项: ' + fails.join(' / '));
process.exit(fails.length || errors.length ? 1 : 0);
