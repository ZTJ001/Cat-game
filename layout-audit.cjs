// 关卡布局 / 软锁审计（纯几何，无渲染依赖）
// 方法：把厨房栅格化，按游戏的 blocked() 规则算出猫与机器人的可行走域；
// 再模拟「一台机器人停在某个位置」，把猫无法贴身挤过的区域设为障碍，
// flood fill 检查是否切出一块猫逃不出去的孤岛 —— 这就是被堵住的软锁。
const fs = require('fs');

const file = process.argv[2] || (__dirname + '/dist/index.html');
const html = fs.readFileSync(file, 'utf8');

const wh = html.match(/var W = (\d+), H = (\d+)/);
if (!wh) throw new Error('找不到 W/H 定义');
const W = +wh[1], H = +wh[2];

const fm = html.match(/var furniture = (\[[\s\S]*?\]);/);
if (!fm) throw new Error('找不到 furniture 定义');
const furniture = Function('return ' + fm[1])();

const CAT = 17, ROBOT = 20, PAD = 8;   // 与 blocked() 一致：碰撞半径额外 +2
const CAT_INFL = CAT + 2;
const ROBOT_INFL = ROBOT + 2;
const STEP = 8;
const GW = Math.floor(W / STEP), GH = Math.floor(H / STEP);
const N = GW * GH;

function blocked(x, y, r) {
  if (x < r + PAD || x > W - r - PAD || y < r + PAD || y > H - r - PAD) return true;
  for (const f of furniture) {
    const cx = Math.max(f.x, Math.min(x, f.x + f.w));
    const cy = Math.max(f.y, Math.min(y, f.y + f.h));
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy < (r + 2) * (r + 2)) return true;
  }
  return false;
}
const gx = (i) => (i % GW) * STEP + STEP / 2;
const gy = (i) => Math.floor(i / GW) * STEP + STEP / 2;

const walkCat = new Uint8Array(N);
const walkRobot = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const x = gx(i), y = gy(i);
  walkCat[i] = blocked(x, y, CAT_INFL) ? 0 : 1;
  walkRobot[i] = blocked(x, y, ROBOT_INFL) ? 0 : 1;
}

// 4 邻域 flood fill，返回每个格所属的分量编号；label=0 表示障碍
function components(free) {
  const lab = new Int32Array(N);
  const sizes = [0];
  const queue = new Int32Array(N);
  let cur = 0;
  for (let s = 0; s < N; s++) {
    if (!free[s] || lab[s]) continue;
    cur++;
    let head = 0, tail = 0;
    queue[tail++] = s; lab[s] = cur;
    while (head < tail) {
      const i = queue[head++];
      const r = Math.floor(i / GW), c = i % GW;
      if (c > 0 && free[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; queue[tail++] = i - 1; }
      if (c < GW - 1 && free[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; queue[tail++] = i + 1; }
      if (r > 0 && free[i - GW] && !lab[i - GW]) { lab[i - GW] = cur; queue[tail++] = i - GW; }
      if (r < GH - 1 && free[i + GW] && !lab[i + GW]) { lab[i + GW] = cur; queue[tail++] = i + GW; }
    }
    sizes[cur] = tail;
  }
  return { lab, sizes, count: cur };
}

const base = components(walkCat);
const totalFree = walkCat.reduce((a, b) => a + b, 0);
const mainLabel = base.sizes.indexOf(Math.max(...base.sizes.slice(1)));
const orphanCells = totalFree - base.sizes[mainLabel];

// 边界环：沿猫能站的最外圈走一圈，检查是否处处可通行且同属主区域
// 用「格中心」采样最外圈，而不是用理论边界坐标：
// 例如 y=515 会落到中心 516 的格，那里本就被 blocked() 判为界外。
const c0 = Math.ceil((CAT + PAD + 2 - STEP / 2) / STEP);
const c1 = Math.floor((W - CAT - PAD - 2 - STEP / 2) / STEP);
const r0 = c0, r1 = Math.floor((H - CAT - PAD - 2 - STEP / 2) / STEP);

function boundaryRing() {
  const pts = [];
  for (let c = c0; c <= c1; c++) {
    pts.push(c + r0 * GW, c + r1 * GW);
  }
  for (let r = r0; r <= r1; r++) {
    pts.push(c0 + r * GW, c1 + r * GW);
  }
  let blockedPts = 0, offMain = 0;
  for (const i of pts) {
    if (i < 0 || i >= N || !walkCat[i]) { blockedPts++; continue; }
    if (base.lab[i] !== mainLabel) offMain++;
  }
  return { total: pts.length, blockedPts, offMain };
}

// 环形走廊的最窄处：从四边向内数连续可行走格数
function corridorWidth() {
  let min = Infinity, where = '';
  const scan = (label, fixed, horizontal, forward) => {
    for (let v = (horizontal ? c0 : r0); v <= (horizontal ? c1 : r1); v++) {
      let d = 0;
      while (d < (horizontal ? GH : GW)) {
        const line = forward ? (horizontal ? r0 + d : c0 + d) : (horizontal ? r1 - d : c1 - d);
        const i = horizontal ? line * GW + v : v * GW + line;
        if (line < 0 || line >= (horizontal ? GH : GW) || !walkCat[i]) break;
        d++;
      }
      if (d < min) { min = d; where = `${label} @${horizontal ? gx(v) : gy(v)}`; }
    }
  };
  scan('上', 0, true, true);
  scan('下', 0, true, false);
  scan('左', 0, false, true);
  scan('右', 0, false, false);
  return { cells: min, px: min * STEP, where };
}

// 道具生成余量：鱼干/逗猫棒用 blocked(...,46)，机器人用 blocked(...,26)
function spawnBudget() {
  let fish = 0, robot = 0, fish40 = 0;
  for (let i = 0; i < N; i++) {
    const x = gx(i), y = gy(i);
    if (!blocked(x, y, 46)) fish++;
    if (!blocked(x, y, 36)) fish40++;
    if (!blocked(x, y, 26)) robot++;
  }
  return { fish, fish40, robot };
}

// 软锁检测：一台机器人占位后，是否切出猫逃不出去的孤岛
// 机器人占位半径取 CAT + ROBOT（保守），表示猫无法贴身从它旁边挤过
const BLOCK_R = CAT + ROBOT;
const SAMPLE = 16;                       // 候选机器人位置采样步长
const MIN_TRAP = 30;                     // 孤立区 >= 30 格 (1920 px^2) 视为软锁
const traps = [];
const freeBuf = new Uint8Array(N);
const labBuf = new Int32Array(N);
const queue = new Int32Array(N);

function floodWithRobot(rx, ry) {
  freeBuf.set(walkCat);
  const rad = Math.ceil(BLOCK_R / STEP) + 1;
  const cgx = Math.floor(rx / STEP), cgy = Math.floor(ry / STEP);
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const c = cgx + dx, r = cgy + dy;
      if (c < 0 || c >= GW || r < 0 || r >= GH) continue;
      const px = c * STEP + STEP / 2, py = r * STEP + STEP / 2;
      if ((px - rx) ** 2 + (py - ry) ** 2 < BLOCK_R * BLOCK_R) freeBuf[r * GW + c] = 0;
    }
  }
  // 标出全部剩余连通分量，取最大的作为「主区域」，其余即为被机器人切出的孤岛。
  // 不能用固定种子：种子可能恰好落在小孤岛里，会把大区域误判为孤立。
  labBuf.fill(0);
  let remain = 0, maxComp = 0, label = 0;
  for (let i = 0; i < N; i++) if (freeBuf[i]) remain++;
  for (let s = 0; s < N; s++) {
    if (!freeBuf[s] || labBuf[s]) continue;
    label++;
    let head = 0, tail = 0;
    queue[tail++] = s; labBuf[s] = label;
    while (head < tail) {
      const i = queue[head++];
      const r = Math.floor(i / GW), c = i % GW;
      if (c > 0 && freeBuf[i - 1] && !labBuf[i - 1]) { labBuf[i - 1] = label; queue[tail++] = i - 1; }
      if (c < GW - 1 && freeBuf[i + 1] && !labBuf[i + 1]) { labBuf[i + 1] = label; queue[tail++] = i + 1; }
      if (r > 0 && freeBuf[i - GW] && !labBuf[i - GW]) { labBuf[i - GW] = label; queue[tail++] = i - GW; }
      if (r < GH - 1 && freeBuf[i + GW] && !labBuf[i + GW]) { labBuf[i + GW] = label; queue[tail++] = i + GW; }
    }
    if (tail > maxComp) maxComp = tail;
  }
  return remain - maxComp;
}

for (let y = CAT + PAD; y <= H - CAT - PAD; y += SAMPLE) {
  for (let x = CAT + PAD; x <= W - CAT - PAD; x += SAMPLE) {
    if (blocked(x, y, ROBOT_INFL)) continue;      // 机器人自己站不进去的位置跳过
    const isolated = floodWithRobot(x, y);
    if (isolated >= MIN_TRAP) traps.push({ x, y, cells: isolated });
  }
}
traps.sort((a, b) => b.cells - a.cells);

const ring = boundaryRing();
console.log('=== 布局审计：' + file.split('/').slice(-2).join('/') + ' ===');
console.log(`画布 ${W}x${H} | 家具 ${furniture.length} 件 | 栅格 ${GW}x${GH} (${N} 格，${STEP}px)`);
furniture.forEach((f) => console.log(`  ${f.type.padEnd(8)} x=${String(f.x).padStart(3)}..${String(f.x + f.w).padStart(3)}  y=${String(f.y).padStart(3)}..${String(f.y + f.h).padStart(3)}  (${f.w}x${f.h})`));
console.log('');
console.log(`猫可行走: ${totalFree} 格 (${(totalFree / N * 100).toFixed(1)}%) | 连通分量: ${base.count} | 非主区域孤岛格: ${orphanCells}`);
console.log(`机器人可行走: ${walkRobot.reduce((a, b) => a + b, 0)} 格`);
console.log(`边界环采样 ${ring.total} 点 | 不可通行 ${ring.blockedPts} | 不属于主区域 ${ring.offMain}  -> ${ring.blockedPts + ring.offMain === 0 ? '整圈畅通' : '存在断点'}`);
const corridor = corridorWidth();
const spawn = spawnBudget();
console.log(`环形走廊最窄处: ${corridor.cells} 格 (${corridor.px}px) 于 ${corridor.where}`);
console.log(`道具生成可用格: 鱼干/逗猫棒(r46) ${spawn.fish} 格 | 放宽到r36 ${spawn.fish40} 格 | 机器人(r26) ${spawn.robot} 格`);
console.log('');
console.log(`单台机器人可造成的软锁点: ${traps.length} 个 (孤立 >= ${MIN_TRAP} 格)`);
traps.slice(0, 8).forEach((t) => console.log(`  (${String(t.x).padStart(3)},${String(t.y).padStart(3)}) -> 封住 ${t.cells} 格 (约 ${t.cells * STEP * STEP} px²)`));
if (traps.length === 0) console.log('  （无）');
console.log('');
const pass = ring.blockedPts + ring.offMain === 0 && orphanCells === 0
  && traps.length === 0 && corridor.px >= 64 && spawn.fish >= 60;
console.log('>>> 结论: ' + (pass ? 'PASS 无边界软锁' : 'FAIL 存在可被堵死的区域'));
process.exit(pass ? 0 : 1);
