// 用 stub 的 canvas/DOM 跑一遍游戏脚本，捕获运行时错误。
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
      _set: cls,
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
const ctxTarget = {
  canvas: { width: 0, height: 0 },
};
const ctx = new Proxy(ctxTarget, {
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

const sandbox = {
  console,
  document: {
    getElementById: (id) => (id === 'c' ? canvas : (els[id] || fakeEl(id))),
    addEventListener: noop,
  },
  window: {
    devicePixelRatio: 2,
    addEventListener: (t, f) => { listeners[t] = f; },
    AudioContext: undefined,
  },
  location: { search: '' },
  requestAnimationFrame: (cb) => { sandbox.__raf = cb; return 1; },
  setTimeout: (f) => 0,
  Math,
  Date,
};
sandbox.window.AudioContext = undefined;
sandbox.globalThis = sandbox;

let errors = [];
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'game.js' });
} catch (e) {
  errors.push('初始化异常: ' + e.message + '\n' + e.stack);
}

const raf = sandbox.__raf;
if (sandbox.window.__gameState) {
  const g0 = sandbox.window.__gameState();
  console.log('[诊断] 初始 phase=' + g0.phase + ' 鱼干数=' + (g0.pickups || []).length + ' 猫=' + JSON.stringify(g0.hero));
}
if (typeof raf !== 'function') errors.push('未注册 requestAnimationFrame');

// 跑 120 帧待机
if (raf) {
  for (let i = 1; i <= 120; i++) {
    try { raf(i * 16.7); } catch (e) { errors.push('待机第' + i + '帧: ' + e.message + '\n' + e.stack.split('\n')[1]); break; }
  }
}

// 点击开始
const btn = els['btn'];
if (btn && btn._h.click) {
  try { btn._h.click(); } catch (e) { errors.push('开始按钮: ' + e.message); }
} else errors.push('按钮未绑定 click');

// 用游戏自带的 __autoplay 驱动，跑最多 120 秒，看能否通关
let endedAt = 0, finalPhase = '';
let prevPos = null, moved = 0, minFishD = 1e9, frames = 0;
if (raf) {
  let base = 120 * 16.7;
  for (let i = 1; i <= 14400; i++) {
    try {
      if (sandbox.window.__autoplay && i % 6 === 0) {
        sandbox.window.__autoplay(sandbox.window.__gameState());
      }
      {
        const g = sandbox.window.__gameState();
        if (prevPos) moved += Math.hypot(g.hero.x - prevPos.x, g.hero.y - prevPos.y);
        prevPos = g.hero; frames++;
        (g.pickups || []).forEach((p) => {
          const d = Math.hypot(p.x - g.hero.x, p.y - g.hero.y);
          if (d < minFishD) minFishD = d;
        });
      }
      raf(base + i * 16.7);
    } catch (e) {
      errors.push('游戏中第' + i + '帧: ' + e.message + '\n' + (e.stack || '').split('\n')[1]);
      break;
    }
    if (i % 60 === 0) {
      const st = sandbox.window.__gameState();
      if (st.phase === 'won' || st.phase === 'lost') { endedAt = i; finalPhase = st.phase; break; }
    }
  }
}
const st = sandbox.window.__gameState ? sandbox.window.__gameState() : null;
if (st) console.log('结束时状态:', JSON.stringify({ phase: st.phase, score: st.score, hearts: st.hearts, time: st.time, enemies: st.enemies.length }));
console.log('结束帧:', endedAt || '(未结束)');
console.log('猫总位移:', Math.round(moved), 'px / 平均帧位移', (moved/frames).toFixed(2), 'px');
console.log('与鱼干最近距离历史最小值:', Math.round(minFishD), 'px');

console.log('=== 结果 ===');
console.log('HUD 标题元素文本:', els['ttl'] ? els['ttl'].textContent : '(无)');
console.log('统计文本:', els['stat'] ? els['stat'].textContent : '(无)');
console.log('按钮文本:', els['btn'] ? els['btn'].textContent : '(无)');
if (errors.length) {
  console.log('发现 ' + errors.length + ' 个问题:');
  errors.forEach((e) => console.log(' - ' + e));
  process.exitCode = 1;
} else {
  console.log('720 帧全部通过，无运行时异常。');
}
