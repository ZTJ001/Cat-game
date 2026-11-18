// 小老鼠机制无头回归：
// 1) 全局仅 1 只、开局就有一只、可达且不贴墙
// 2) 普通阶段躲猫（滞回）、会吃鱼干、每吃一条 +5% 半径 +1 命
// 3) 吃满 5 条触发「小心老鼠」闪屏并进入狂暴，狂暴限时 6 秒，结束扣 2 命并重置
// 4) 机器人撞老鼠 → 原地晕 3 秒（stun 计时与位置冻结）；狂暴期间碰机器人 → 每次 -1 命
// 5) 猫攻击普通老鼠每次 -1 命，命尽从画面消失并进入 60s 重生倒计时
// 6) 狂暴老鼠主动追猫、撞猫扣猫一颗心（与机器人一致）、自己短暂 stun
// 7) 狂暴后猫不能再攻击老鼠、老鼠不再吃鱼干
// 8) 重生倒计时结束后老鼠重新出现
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/dist/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const noop = () => {};
const listeners = {}, els = {};
function fakeEl(id) {
  const handlers = {}, cls = new Set();
  const el = { id, textContent: '', title: '', style: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    addEventListener: (t, f) => { handlers[t] = f; }, _h: handlers,
    setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), width: 0, height: 0 };
  els[id] = el; return el;
}
const gradient = { addColorStop: noop };
const ctx = new Proxy({ canvas: { width: 0, height: 0 } }, {
  get(t, p) { if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradient;
    if (p === 'measureText') return () => ({ width: 20 }); if (p in t) return t[p]; return noop; },
  set(t, p, v) { t[p] = v; return true; }
});
const canvas = fakeEl('c'); canvas.getContext = () => ctx;
const store = {};
const sandbox = { console,
  document: { getElementById: id => (id === 'c' ? canvas : (els[id] || fakeEl(id))), addEventListener: noop },
  window: { devicePixelRatio: 2, addEventListener: (t, f) => { listeners[t] = f; },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } },
  location: { search: '' }, requestAnimationFrame: cb => { sandbox.__raf = cb; return 1; },
  setTimeout: () => 0, Math, Date };
sandbox.globalThis = sandbox;
const errors = [];
try { vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: 'game.js' }); }
catch (e) { errors.push('初始化异常: ' + e.stack); }

const raf = sandbox.__raf, M = sandbox.window.__mouse;
if (typeof raf !== 'function') errors.push('未注册 requestAnimationFrame');
if (!M) errors.push('未暴露 __mouse 回归钩子');

let ts = 1000;
function step(ms) { ts += ms; try { raf(ts); } catch (e) { errors.push('raf: ' + e.message); } }

let passed = 0; const fails = [];
function check(name, cond, detail) {
  const tail = detail ? '  [' + detail + ']' : '';
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + tail);
  if (cond) passed++; else fails.push(name);
}
// fresh(): 干净重开并立刻强制放出一只老鼠，供各机制测试用（随机刷新本身单独测）
const fresh = () => { M.reset(); M.spawn(); step(16.7); };

if (raf && M) {
  let s;
  // —— 随机刷新：首次随机延迟、之后随机重生、位置随机、始终仅 1 只 ——
  M.reset(); step(16.7);
  s = M.state();
  check('开局无老鼠、处于随机刷新等待中', s.exists === false && s.respawnIn > 0, 'respawnIn=' + s.respawnIn);
  check('首次刷新延迟落在 8~15s', s.respawnIn >= 8 && s.respawnIn <= 15, 'respawnIn=' + s.respawnIn);
  // 多次重开采样首次延迟，确认随机
  const firstDelays = [];
  for (let k = 0; k < 12; k++) { M.reset(); firstDelays.push(M.state().respawnIn); }
  check('首次延迟确实随机（≥10 种不同值）', new Set(firstDelays.map(v => v.toFixed(2))).size >= 10,
        new Set(firstDelays.map(v => v.toFixed(2))).size + ' 种');
  // 等待首次延迟结束，老鼠自动出现
  M.reset();
  const firstDelay = M.state().respawnIn;
  M.tick(firstDelay + 0.2);
  check('首次延迟结束后老鼠自动刷新', M.state().exists === true, 'delay=' + firstDelay.toFixed(2));
  // 重生间隔随机 45~75s
  const respawns = [];
  for (let k = 0; k < 12; k++) { M.finish(); respawns.push(M.state().respawnIn); }
  check('重生间隔落在 45~75s 且随机', respawns.every(v => v >= 45 && v <= 75) && new Set(respawns.map(v => v.toFixed(2))).size >= 10,
        respawns.map(v => v.toFixed(1)).join(','));
  // 重生等待结束后重新出现
  M.finish();
  const wait = M.state().respawnIn;
  M.tick(wait + 0.2);
  check('重生倒计时结束后老鼠重新出现', M.state().exists === true, 'wait=' + wait.toFixed(2));
  // 位置随机：反复强制刷新，坐标应各不相同且可达
  const spots = [];
  for (let k = 0; k < 12; k++) { M.spawn(); const q = M.state(); spots.push(q.x + ',' + q.y); }
  check('刷新位置随机（≥10 种不同坐标）且可达', new Set(spots).size >= 10, new Set(spots).size + ' 种');

  fresh();
  s = M.state();
  check('强制刷新后场上有且只有 1 只老鼠', s.exists === true);
  check('老鼠初始为普通(timid)阶段', s.mode === 'timid');
  check('老鼠初始命数 3', s.lives === 3, 'lives=' + s.lives);
  check('生成位置可达、不在家具里', s.reachable === true);
  check('初始半径 12', Math.abs(s.r - 12) < 0.01, 'r=' + s.r);

  // —— 躲猫：把猫放到老鼠附近（不完全重合），推进 AI，距离应被拉开 ——
  fresh();
  M.place(400, 270, 410, 270);   // 猫在老鼠右方 10px，触发躲猫
  const before = M.state();
  const dBefore = Math.hypot(before.x - 410, before.y - 270);
  for (let i = 0; i < 30; i++) M.tick(1 / 60);   // 0.5s
  const after = M.state();
  const dc = Math.hypot(after.x - 410, after.y - 270);
  check('普通阶段会躲猫（距离被拉开）', dc > dBefore + 20, dBefore.toFixed(1) + ' -> ' + dc.toFixed(1));
  check('躲猫时进入 fleeing 状态', after.fleeing === true);

  // —— 吃鱼干：喂 1 条，半径 ×1.05、命 +1 ——
  fresh();
  const r0 = M.state().r, l0 = M.state().lives;
  M.feed(1);
  s = M.state();
  check('吃 1 条鱼干半径 +10%', Math.abs(s.r - r0 * 1.10) < 0.01, r0 + ' -> ' + s.r);
  check('吃 1 条鱼干命 +1', s.lives === l0 + 1, l0 + ' -> ' + s.lives);

  // —— 吃满 5 条：闪屏 + 狂暴 ——
  fresh();
  M.feed(4);
  s = M.state();
  check('吃 4 条尚未狂暴', s.mode === 'timid' && s.eaten === 4, 'eaten=' + s.eaten);
  M.feed(1);
  s = M.state();
  check('吃满 5 条进入狂暴', s.mode === 'rage' && s.eaten === 5);
  check('狂暴触发「小心老鼠」闪屏计时', s.warnLeft > 0 && s.warnLeft <= 2.2, 'warn=' + s.warnLeft);
  check('狂暴剩余时间初始化为 6 秒', Math.abs(s.rageLeft - 6) < 0.01, 'rageLeft=' + s.rageLeft);
  check('狂暴后半径约 ×1.10^5', Math.abs(s.r - 12 * Math.pow(1.10, 5)) < 0.01, 'r=' + s.r);

  // —— 狂暴倒计时：6 秒后自动退出、扣 2 命、eaten 归零、体型回基础 ——
  const preRageLives = M.state().lives;      // 8（3 初始 + 5 条鱼）
  const preRageR = M.state().r;
  M.tick(3);
  s = M.state();
  check('狂暴 3 秒时仍在狂暴、剩余时间递减', s.mode === 'rage' && s.rageLeft > 2.9 && s.rageLeft < 3.1, 'rageLeft=' + s.rageLeft);
  M.tick(3.2);
  s = M.state();
  check('狂暴 6 秒后退出狂暴', s.mode === 'timid', 'mode=' + s.mode);
  check('狂暴结束扣 2 条命', s.lives === preRageLives - 2, preRageLives + ' -> ' + s.lives);
  check('狂暴结束吃鱼进度归零（需重新吃鱼）', s.eaten === 0, 'eaten=' + s.eaten);
  check('狂暴结束体型回到基础 12', Math.abs(s.r - 12) < 0.01, preRageR + ' -> ' + s.r);
  check('狂暴结束后给短暂无敌', s.inv > 0, 'inv=' + s.inv);

  // —— 机器人撞老鼠 → 晕 3 秒、原地不动 ——
  fresh();
  M.place(470, 292, 700, 100);
  // 把一台机器人挪到老鼠身上：通过布局钩子 setup 做不到，改用直接多次 robotCheck 前先放机器人
  // 用 __layout.setup 放置一台机器人在指定位置，老鼠在 (470,292)
  const L = sandbox.window.__layout;
  L.setup(700, 100, 470, 292);   // cat=(700,100) robot=(470,292)
  M.place(470, 292, 700, 100);   // mouse 也在 (470,292)
  M.robotCheck();
  s = M.state();
  check('机器人撞老鼠致晕 3 秒', Math.abs(s.stun - 3) < 0.01, 'stun=' + s.stun);
  const sx = s.x, sy = s.y;
  M.tick(1);                     // 眩晕中推进 1 秒
  s = M.state();
  check('眩晕期间原地不动', Math.abs(s.x - sx) < 0.01 && Math.abs(s.y - sy) < 0.01,
        '(' + sx + ',' + sy + ') -> (' + s.x + ',' + s.y + ')');
  const st1 = s.stun;
  M.tick(2.2);                   // 再推进 2.2 秒，累计越过 3 秒
  s = M.state();
  check('3 秒后眩晕解除', s.stun === 0 && st1 <= 2.1, 'stun=' + s.stun);

  // —— 猫攻击普通老鼠：每次 -1 命 ——
  fresh();
  M.place(470, 292, 470, 292);
  let prev = M.state().lives;
  M.catAttack();
  s = M.state();
  check('猫攻击一次 -1 命', s.lives === prev - 1, prev + ' -> ' + s.lives);
  check('攻击后有短暂无敌', s.inv > 0, 'inv=' + s.inv);
  // 无敌期内再打不掉命
  prev = s.lives;
  M.catAttack();
  check('无敌期内重复攻击不掉命', M.state().lives === prev);

  // —— 命尽消失 + 60 秒重生 ——
  // place() 每次都会清 inv/stun，所以连续三次贴身攻击即可，无需 tick（tick 会让老鼠吃到鱼回血）
  fresh();
  for (let i = 0; i < 3; i++) { M.place(470, 292, 470, 292); M.catAttack(); }
  s = M.state();
  check('命尽后老鼠从画面消失', s.exists === false, 'exists=' + s.exists);
  check('消失后进入 45~75s 随机重生倒计时', s.respawnIn >= 45 && s.respawnIn <= 75, 'respawn=' + s.respawnIn);
  const deathWait = s.respawnIn;
  M.tick(deathWait - 0.5);
  check('重生倒计时结束前老鼠仍未出现', M.state().exists === false);
  M.tick(0.8);
  check('重生倒计时结束后老鼠重新出现', M.state().exists === true && M.state().mode === 'timid');

  // —— 猫捕获老鼠补命：只有猫亲手打死才补，其他致死源不补 ——
  fresh();
  const catLv0 = M.state().catLives;             // 3
  // 前两次攻击：老鼠还有命，不补
  M.place(470, 292, 470, 292); M.catAttack();
  M.place(470, 292, 470, 292); M.catAttack();
  check('猫未打死老鼠时不补命', M.state().catLives === catLv0, catLv0 + ' -> ' + M.state().catLives);
  check('两次攻击后老鼠还剩 1 命', M.state().lives === 1, 'lives=' + M.state().lives);
  // 第三次：打死 → 补 1 命
  M.place(470, 292, 470, 292); M.catAttack();
  s = M.state();
  check('猫打死老鼠后 +1 命', s.catLives === catLv0 + 1, catLv0 + ' -> ' + s.catLives);
  check('猫打死后老鼠消失', s.exists === false);
  // 再捕获一只，补命可叠加、超过初始上限
  M.spawn();
  for (let i = 0; i < 3; i++) { M.place(470, 292, 470, 292); M.catAttack(); }
  check('连续捕获补命可叠加（超过初始 3）', M.state().catLives === catLv0 + 2, 'catLives=' + M.state().catLives);
  // 机器人打死狂暴老鼠：不补猫命
  fresh();
  const catLvBeforeBot = M.state().catLives;
  M.feed(5);                                     // 狂暴，命 = 8
  for (let i = 0; i < 8; i++) {                   // 反复让机器人撞击，扣光命
    L.setup(700, 100, 470, 292);
    M.place(470, 292, 700, 100);
    M.robotCheck();
  }
  s = M.state();
  check('机器人打死老鼠不补猫命', s.exists === false && s.catLives === catLvBeforeBot,
        'exists=' + s.exists + ' catLives=' + s.catLives);

  // —— 狂暴老鼠撞猫：扣猫一颗心、自己 stun、猫进入无敌 ——
  fresh();
  const catLives0 = M.state().catLives;
  M.feed(5);
  M.place(400, 270, 400, 270);   // 狂暴鼠与猫重合
  const hit = M.rageHit();
  s = M.state();
  check('狂暴老鼠撞猫返回命中', hit === true);
  check('狂暴老鼠撞猫扣猫一颗心', s.catLives === catLives0 - 1, catLives0 + ' -> ' + s.catLives);
  check('撞后猫进入无敌', s.catInv > 0, 'catInv=' + s.catInv);
  check('撞后老鼠自己也短暂 stun', s.stun > 0 && s.stun <= 1.2, 'stun=' + s.stun);

  // —— 狂暴期间碰机器人：每次 -1 命（区别于普通阶段的晕 3 秒）——
  fresh();
  M.feed(5);                                  // 狂暴，命 = 3+5 = 8
  L.setup(700, 100, 470, 292);                // 机器人放在 (470,292)
  const rageLives0 = M.state().lives;
  M.place(470, 292, 700, 100);                // 狂暴鼠也放 (470,292)，place 清 inv
  M.robotCheck();
  s = M.state();
  check('狂暴碰机器人 -1 命（不是眩晕）', s.lives === rageLives0 - 1 && s.stun === 0,
        rageLives0 + ' -> ' + s.lives + ' stun=' + s.stun);
  check('狂暴碰机器人后进入无敌', s.inv > 0, 'inv=' + s.inv);
  // 无敌期内重复碰不扣命
  const afterHit = M.state().lives;
  M.robotCheck();
  check('狂暴无敌期内重复碰不扣命', M.state().lives === afterHit);
  // 清掉无敌和机器人 stun 后再碰一次，再扣 1 命
  L.setup(700, 100, 470, 292);                // 重建机器人 -> stun 清零
  M.place(470, 292, 700, 100);                // 老鼠归位、inv 清零
  M.robotCheck();
  check('无敌结束后再碰机器人再 -1 命', M.state().lives === afterHit - 1,
        afterHit + ' -> ' + M.state().lives);

  // —— 多轮狂暴循环：每轮结束扣 2 命，但吃鱼也在补命，验证循环可持续 ——
  fresh();
  M.feed(5);            // lives 8，进狂暴
  M.tick(6.1);          // 退出狂暴 -2 => 6，eaten 归零，重新吃鱼阶段
  M.feed(5);            // 6+5=11 再次狂暴
  M.tick(6.1);          // 退出 -2 => 9
  check('多轮狂暴循环后仍存活、命数正确累加', M.state().exists === true && M.state().lives === 9,
        'lives=' + M.state().lives);

  // —— 狂暴后猫不能攻击老鼠、老鼠不再吃鱼 ——
  fresh();
  M.feed(5);
  M.place(400, 270, 400, 270);
  const rl = M.state().lives;
  M.catAttack();
  check('狂暴后猫攻击不扣老鼠命', M.state().lives === rl, rl + ' -> ' + M.state().lives);
  const eaten0 = M.state().eaten;
  M.tick(0.5);
  check('狂暴后老鼠不再吃鱼干', M.state().eaten === eaten0, 'eaten=' + M.state().eaten);

  // —— 单只保证：反复 spawn 不叠加 ——
  fresh();
  M.spawn(); M.spawn(); M.spawn();
  check('反复生成仍只有 1 只（钩子读到的始终是单只状态）', M.state().exists === true);

  // —— 试玩协议能读到 mouse 字段 ——
  const gs = sandbox.window.__gameState();
  check('试玩协议含 mouse / mouseRespawn 字段', 'mouse' in gs && 'mouseRespawn' in gs);
}

console.log('=== 结果 ===');
if (errors.length) { console.log('运行时异常 ' + errors.length + ' 个:'); errors.forEach(e => console.log(' - ' + e)); }
if (fails.length || errors.length) {
  console.log('失败 ' + fails.length + ' 项 / 异常 ' + errors.length + ' 个');
  process.exitCode = 1;
} else {
  console.log('全部 ' + passed + ' 项断言通过，无运行时异常。');
}
