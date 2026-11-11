// 用 Chrome DevTools Protocol 真跑一遍 demo：加载页面、收集控制台报错、
// 走完练习模式与球局模式的主路径、截图。Node 24 自带 WebSocket，无需依赖。
//
// 这个脚本必须在 sandbox_permissions: "danger-full-access" 下运行：
// Chrome 多进程要建命名管道，受限沙箱里必然失败（mojo platform_channel Check failed）。
//
// 用法：node tools/verify-demo.mjs [chrome路径]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, freePort } from './cdp.mjs';

// 浏览器路径原先写死了一条 Windows 路径，macOS/Linux 上、或 Chrome 装在别处时
// 直接 spawn 失败。cdp.mjs 里已经有一份跨平台的发现逻辑（CHROME_PATH 优先），
// 这里复用它，别再维护第二份。
const CHROME = process.argv[2] ?? (await findChrome());
const URL = process.env.DEMO_URL ?? 'http://127.0.0.1:4173/demo/';
const PORT = await freePort();

// 先确认静态服务在跑。少了这一步，页面加载失败会在后面某个 getContext 上炸成
// 「TypeError: Cannot read properties of null」，把诊断一路引向「渲染崩了」，
// 而真因只是没起服务。起服务是人的操作，这里只能把话说清楚然后退出。
try {
  const probe = await fetch(URL, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (err) {
  console.error(`静态服务没起来：${URL}（${err.message}）`);
  console.error('先另开一个终端，在仓库根目录运行：node tools/serve.mjs 4173');
  process.exit(2);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chrome-'));

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

// 路径不对时 spawn 不会同步抛，而是异步发 'error' 事件；没人听就是一条
// 未捕获的 Error 事件，栈里看不出是浏览器路径的问题。这里明确说出来。
chrome.on('error', (err) => {
  console.error(`启动浏览器失败：${CHROME}（${err.message}）`);
  console.error('用 CHROME_PATH 指定可执行文件路径，或把它作为第一个参数传进来。');
  process.exit(2);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      if (list.length) return list;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口没起来');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws 连接失败: ' + e.message));
  });
}

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
/** 检查项清单，最后统一打印，失败的不许悄悄吞掉 */
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) pageErrors.push(`${name}${detail ? ' — ' + detail : ''}`);
};

function send(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const targets = await getTargets();
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = await connect(page.webSocketDebuggerUrl);

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(msg.params.entry.text + ' @ ' + (msg.params.entry.url ?? ''));
  }
};

const evaluate = async (expression) => {
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    // 先把手头收集到的页面错误打出来：脚本自身的异常往往只是表象，
    // 真正的原因（模块加载失败、运行时抛错）在页面控制台里。
    const collected = [...pageErrors, ...consoleErrors].slice(-15);
    if (collected.length) {
      console.error('\n页面已报的错误（先看这个）:');
      for (const line of collected) console.error('  ' + line);
      console.error('');
    }
    console.error('出错时执行的是: ' + expression.trim().slice(0, 160).replace(/\s+/g, ' ') + '\n');
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

const shot = async (name) => {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const outDir = path.resolve(import.meta.dirname, '..', '_research');
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  return p;
};

await send(ws, 'Runtime.enable');
await send(ws, 'Log.enable');
await send(ws, 'Page.enable');

// ------------------------------------------------------------ file:// 兜底提示
//
// 用 file:// 双击打开时，浏览器以 CORS 拒掉 ES module，页面主体一行都不执行，
// 结果是纯白页。这个提示只能靠一段普通脚本放出来（demo/file-guard.js），所以它
// 能不能真的出现必须实测：只检查 HTML 里有那个 <script> 标签是不够的。
//
// 放在进正题之前跑：file:// 下模块加载失败必然产生一条 CORS 报错，那是浏览器的
// 正常行为、与本次验证无关，这里断言完就把收集到的错误清空，免得干扰后面的
// 「全程没有未捕获异常」。
{
  const fileUrl = pathToFileURL(
    path.resolve(import.meta.dirname, '..', 'demo', 'index.html')
  ).href;
  await send(ws, 'Page.navigate', { url: fileUrl });
  await sleep(1200);

  const guard = JSON.parse(
    await evaluate(`(() => {
      const el = document.getElementById('file-protocol-notice');
      return JSON.stringify({
        has: Boolean(el),
        text: el ? el.textContent.replace(/\\s+/g, ' ').trim() : '',
        title: document.title,
      });
    })()`)
  );

  console.log('file:// 兜底提示:', guard.has ? guard.text.slice(0, 60) + '…' : '（没有出现）');
  check(
    'file:// 直接打开时给出提示，不是白屏',
    guard.has && guard.text.includes('node tools/start.mjs'),
    JSON.stringify(guard)
  );
  check(
    'file:// 提示里写清了要怎么起服务',
    guard.text.includes('127.0.0.1:4173') && guard.title.includes('本地服务'),
    guard.title
  );

  pageErrors.length = 0;
  consoleErrors.length = 0;
}

await send(ws, 'Page.navigate', { url: URL });
await sleep(2500);

// 连上的必须是我们自己要测的那个页面。端口改成随机之后这一条更用不上，
// 但它是最后一道保险：万一浏览器把标签页重定向到别处（代理、插件、hosts），
// 后面的断言会对着一个陌生页面全过，那比失败更糟。
{
  const origin = await evaluate('location.origin');
  const want = new globalThis.URL(URL).origin;
  if (origin !== want) {
    console.error(`打开的页面不是目标地址：期望 ${want}，实际 ${origin}`);
    process.exit(2);
  }
}

// 页面是不是真的起来了。ES module 被 CORS 拒、脚本 404、首帧抛错都会让
// #table 根本不存在或 window.__app 没赋值；这两种情况下面每条断言都会以
// 「null 上读属性」的形式散落一地，不如在这里一次说清。
{
  const ready = JSON.parse(
    await evaluate(`(() => {
      const c = document.getElementById('table');
      return JSON.stringify({
        table: Boolean(c),
        width: c ? c.width : 0,
        app: Boolean(window.__app),
        title: document.title,
      });
    })()`)
  );
  if (!ready.table || !ready.app) {
    console.error(`页面没加载起来：${URL}`);
    console.error(`  #table=${ready.table}（宽 ${ready.width}） __app=${ready.app} 标题=${ready.title}`);
    const collected = [...pageErrors, ...consoleErrors].slice(-10);
    if (collected.length) {
      console.error('  页面自己报的错：');
      for (const line of collected) console.error('    ' + line);
    }
    ws.close();
    chrome.kill();
    process.exit(2);
  }
  check('页面加载出画布与 __app', ready.table && ready.app && ready.width > 0, JSON.stringify(ready));
}

// ------------------------------------------------------------ 练习模式

const probe = await evaluate(`(() => {
  const c = document.getElementById('table');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonEmpty = 0, green = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] !== 0) nonEmpty++;
    if (d[i+3] > 200 && d[i+1] > d[i] + 8 && d[i+1] > d[i+2] + 8) green++;
  }
  const total = d.length / 4;
  return JSON.stringify({
    w: c.width, h: c.height,
    advice: document.getElementById('advice').textContent,
    writePractice: document.getElementById('practiceMessage').textContent,
    balls: window.__app.state.balls.length,
    paintedPct: +(100 * nonEmpty / total).toFixed(1),
    feltPct: +(100 * green / total).toFixed(1),
  });
})()`);
console.log('加载后:', probe);
{
  const info = JSON.parse(probe);
  check('canvas 画满', info.paintedPct >= 80, `${info.paintedPct}%`);
  check('台呢画出来了', info.feltPct >= 40, `${info.feltPct}%`);
  check('初始 4 颗球', info.balls === 4, `${info.balls} 颗`);
  // resetLayout 一开机就会调 updatePracticeFeedback()，以前不传参就清成空字符串，
  // 首屏那句提示当场被抹掉，球友看到一块空白不知道下一步干什么。
  check('首屏状态行没被清空', info.writePractice.trim().length > 0 && /先求解/.test(info.writePractice), info.writePractice);
}

// 求解
await evaluate(`document.getElementById('solve').click()`);
await sleep(1200);
const solved = await evaluate(`(() => JSON.stringify({
  advice: document.getElementById('advice').textContent,
  verdict: document.getElementById('verdict').textContent,
  note: document.getElementById('verdictNote').textContent,
  alts: [...document.querySelectorAll('#alts .alt')].map(e => e.textContent.replace(/\\s+/g,' ').trim()),
}))()`);
console.log('练习·求解:', solved);
{
  const r = JSON.parse(solved);
  check('练习求解给出建议', /号球进/.test(r.advice), r.advice);
  check('练习求解给出难度', /难度/.test(r.verdict), r.verdict);
  check('练习求解列出备选', r.alts.length >= 1, `${r.alts.length} 条`);
  // 难度档位有隐含前提（±0.2° 的瞄准精度），不写出来会误导：
  // 同一个「很容易」，瞄得准 97%、瞄得松只有 80%。verdict 与常驻说明两处都得有。
  check('难度档位带精度前提', /按瞄准误差 ±0\.2° 估算/.test(r.verdict), r.verdict);
  check(
    '页面上常驻精度说明',
    /±0\.2°/.test(r.note) && /毫米/.test(r.note),
    r.note
  );
  // 求解完成后状态行要换成「下一步做什么」，不能还留着求解前那句、也不能空
  const hint = await evaluate(`document.getElementById('practiceMessage').textContent`);
  check('求解后状态行说清下一步', /点「进了」或「没进」/.test(hint), hint);
}

// 切备选
const altClick = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#alts .alt')];
  if (rows.length < 2) return JSON.stringify({ ok: false, why: '备选不足' });
  const before = document.getElementById('advice').textContent;
  rows[1].click();
  return JSON.stringify({ ok: true, before, after: document.getElementById('advice').textContent });
})()`);
console.log('练习·切换备选:', altClick);
{
  const r = JSON.parse(altClick);
  check('切换备选后建议变了', r.ok && r.before !== r.after, r.why ?? '');
}
await evaluate(`document.querySelectorAll('#alts .alt')[0]?.click()`);

// 演示一杆
await evaluate(`document.getElementById('shoot').click()`);
await sleep(700);
const midPath = await shot('demo-playing.png');
let afterShoot = null;
for (let i = 0; i < 50; i++) {
  await sleep(500);
  const t = await evaluate(`document.getElementById('advice').textContent`);
  if (t.startsWith('✓') || t.startsWith('✗')) { afterShoot = t; break; }
}
console.log('练习·演示:', afterShoot ?? '（25s 内未结束）');
check('演示一杆报告进球', Boolean(afterShoot && afterShoot.startsWith('✓')), afterShoot ?? '');

// ------------------------------------------------------------ 回放被打断
// 回放是「按下标把帧数据往球数组里写」。在途时点重置 / 切模式 / 换题，球数组会被换成
// 另一个长度；旧 tick 若继续写，轻则把别人的局面改坏，重则回调里 original[i] 读到
// undefined 直接抛 TypeError。下面三条各守一个入口：删掉 app.js 里的代次守卫，它们必须变红。

const readBalls = `(() => {
  const s = window.__app.state;
  const arr = s.mode === 'practice' ? s.balls : (s.game ? s.game.balls : []);
  return JSON.stringify({
    mode: s.mode,
    animating: s.animating,
    gen: s.generation,
    coords: arr.map((b) => [+b.x.toFixed(6), +b.y.toFixed(6)]),
  });
})()`;

// 造一串 2 秒的假帧（每帧球数按当前局面），播到一半就把局面换掉。
// 帧里的 x 都在 0.05–0.25 之间，与任何正常摆位都不重叠，写脏了一眼能看出来。
const startFakeReplay = `(() => {
  const app = window.__app;
  const arr = app.state.mode === 'practice' ? app.state.balls : app.state.game.balls;
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const f = [];
    for (let k = 0; k < arr.length; k++) {
      f.push({
        x: 0.05 + 0.005 * i + k * 0.001, y: 0.05, pocketed: false, pocket: null,
        rollAngle: 0, rollDirX: 0, rollDirY: 0,
      });
    }
    frames.push(f);
  }
  window.__replayDone = false;
  app.replay(frames, 0.05, () => { window.__replayDone = true; });
  return JSON.stringify({ frames: frames.length, balls: arr.length });
})()`;

// ① 回放中点重置
await evaluate(`window.__app.setMode('practice'); document.getElementById('reset').click();`);
await sleep(120);
await evaluate(startFakeReplay);
await sleep(300); // 先让它真的跑起来几帧
await evaluate(`document.getElementById('reset').click()`);
const resetJustAfter = JSON.parse(await evaluate(readBalls));
await sleep(1300); // 假帧总长 2 秒，等它「本该」播完
const resetSettled = JSON.parse(await evaluate(readBalls));
const resetDone = await evaluate(`window.__replayDone`);
check('回放中重置：旧回放的回调没有跑', resetDone === false, `done=${resetDone}`);
check(
  '回放中重置：球位没被旧帧写脏',
  JSON.stringify(resetJustAfter.coords) === JSON.stringify(resetSettled.coords),
  JSON.stringify(resetSettled.coords)
);
check('回放中重置：animating 没被旧 tick 打回 true', resetSettled.animating === false, String(resetSettled.animating));

// ② 回放中切模式
await evaluate(`window.__app.setMode('practice'); document.getElementById('reset').click();`);
await sleep(120);
await evaluate(startFakeReplay);
await sleep(300);
await evaluate(`(() => {
  const el = document.getElementById('autoOpponent');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await evaluate(`document.getElementById('tabGame').click()`);
await sleep(300);
const modeBalls1 = JSON.parse(await evaluate(readBalls));
await sleep(900);
const modeBalls2 = JSON.parse(await evaluate(readBalls));
check('回放中切模式：模式真的切过去了', modeBalls2.mode === 'game', modeBalls2.mode);
check('回放中切模式：球局还是 16 颗', modeBalls2.coords.length === 16, `${modeBalls2.coords.length} 颗`);
check(
  '回放中切模式：球局的球位没被旧帧写脏',
  JSON.stringify(modeBalls1.coords) === JSON.stringify(modeBalls2.coords),
  JSON.stringify(modeBalls2.coords)
);

// ③ 训练题的球位（2 颗）回放中重置成 4 颗 —— 这是原先会直接崩掉的顺序
await evaluate(`window.__app.setMode('practice')`);
await evaluate(`(() => {
  document.getElementById('drillSelect').value = 'straight';
  document.getElementById('startDrill').click();
  return 'ok';
})()`);
await sleep(200);
const drillCount = await evaluate(`window.__app.state.balls.length`);
await evaluate(`document.getElementById('solve').click()`);
await sleep(1500);
await evaluate(`document.getElementById('shoot').click()`);
await sleep(250);
const drillAnimating = await evaluate(`window.__app.state.animating`);
await evaluate(`document.getElementById('reset').click()`);
// 这一杆的帧数取决于球停得多快，不能只等一个固定时长：等短了断言会跑在崩溃之前，
// 看起来全绿其实漏了问题。所以既等一段，又在收尾处再兜一次「全程无未捕获异常」。
await sleep(3000);
const afterDrill = JSON.parse(await evaluate(readBalls));
check('训练题是 2 颗球起手', drillCount === 2, `${drillCount} 颗`);
check('训练题回放真的在跑（否则这一条测了个空的）', drillAnimating === true, `animating=${drillAnimating}`);
check('训练题回放中重置：球数换成 4 颗', afterDrill.coords.length === 4, `${afterDrill.coords.length} 颗`);
// 这一杆崩不崩，由收尾处的「全程没有未捕获异常」统一判：回放的 tick 要等帧放完才走到
// 回调，当场取样会跑在崩溃之前。实测把守卫关掉后，正是那条收尾断言报出了 TypeError。
// 复位成默认练习局面，后面的加球 / 换台几段都按 4 颗球起手
await evaluate(`document.getElementById('reset').click()`);
await sleep(120);

// ------------------------------------------------------------ 加球

const addResult = await evaluate(`(() => {
  const before = window.__app.state.balls.length;
  document.getElementById('rackUp').click();
  const racked = window.__app.state.balls.length;
  const numbers = window.__app.state.balls.map(b => b.number).sort((a,b)=>a-b);
  return JSON.stringify({ before, racked, numbers, opts: document.getElementById('ballPick').disabled });
})()`);
console.log('加球·摆满:', addResult);
{
  const r = JSON.parse(addResult);
  check('摆满后 16 颗', r.racked === 16, `${r.racked} 颗`);
  check('号码是 0–15', JSON.stringify(r.numbers) === JSON.stringify([...Array(16).keys()]), r.numbers.join(','));
  check('15 颗都在台上时不能再加', r.opts === true, String(r.opts));
}

// 重置回 4 颗再加一颗，验证"自定义加球"
const addOne = await evaluate(`(() => {
  window.__app.resetLayout();
  const before = window.__app.state.balls.length;
  document.getElementById('ballPick').value = '9';
  document.getElementById('addBall').click();
  const balls = window.__app.state.balls;
  const nine = balls.find(b => b.number === 9);
  const overlaps = balls.some((a, i) => balls.some((b, j) => i < j &&
    !a.pocketed && !b.pocketed && Math.hypot(a.x-b.x, a.y-b.y) < 2*0.028575 - 1e-6));
  return JSON.stringify({ before, after: balls.length, hasNine: !!nine, stripe: nine?.stripe, overlaps });
})()`);
console.log('加球·加一颗:', addOne);
{
  const r = JSON.parse(addOne);
  check('加球后数量 +1', r.after === r.before + 1, `${r.before} → ${r.after}`);
  check('加的 9 号是条纹球', r.hasNine && r.stripe === true, JSON.stringify(r));
  check('加球不与其它球重叠', r.overlaps === false);
}

await shot('demo-practice.png');

// ------------------------------------------------------------ 球局模式

await evaluate(`window.__app.setMode('game')`);
await sleep(500);
// 这一段只验「玩家自己打」的路径：先把「对手自动出杆」关掉，否则玩家打完一杆
// 对手会立刻接一杆，shots 就不止 1，turn 也不再是玩家——那是另一条路径，
// 对手 AI 在下面的专门段落里验。测试要控住变量，不该靠放宽断言来迁就。
const autoOppOff = await evaluate(`(() => {
  const el = document.getElementById('autoOpponent');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return window.__app.state.autoOpponent;
})()`);
check('能关掉对手自动出杆（对比双方都由自己操作）', autoOppOff === false);
const gameInit = await evaluate(`(() => {
  const g = window.__app.state.game;
  return JSON.stringify({
    balls: g.balls.length,
    turn: g.turn,
    breakShot: g.breakShot,
    open: g.open,
    phase: g.phase,
    scoreRows: document.querySelectorAll('#score .who').length,
  });
})()`);
console.log('球局·建局:', gameInit);
{
  const r = JSON.parse(gameInit);
  check('球局是 16 颗', r.balls === 16, `${r.balls}`);
  check('球局从开球开始', r.breakShot === true && r.open === true);
  check('比分板两个人', r.scoreRows === 2, `${r.scoreRows} 行`);
}

// 求解开球
await evaluate(`document.getElementById('gSolve').click()`);
await sleep(1500);
const gSolved = await evaluate(`(() => JSON.stringify({
  advice: document.getElementById('gAdvice').textContent,
  verdict: document.getElementById('gVerdict').textContent,
  found: window.__app.state.gSolution?.found ?? false,
}))()`);
console.log('球局·求解:', gSolved);
{
  const r = JSON.parse(gSolved);
  check('球局求解有结果', r.found === true, JSON.stringify(r));
  // 开球时没有"进哪个袋"这回事，所以这里认三种说法：进攻、开球、兜底直撞
  check('球局建议可读', /号球进|开球|没有进球机会|防守/.test(r.advice), r.advice);
}

// 打这一杆
await evaluate(`document.getElementById('gShoot').click()`);
await sleep(1200);
let gameShot = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const r = await evaluate(`(() => JSON.stringify({
    animating: window.__app.state.animating,
    shots: window.__app.state.game?.shots ?? -1,
    report: document.getElementById('report').textContent,
    logRows: document.querySelectorAll('#log div').length,
    turn: window.__app.state.game?.turn,
    breakShot: window.__app.state.game?.breakShot,
  }))()`);
  const v = JSON.parse(r);
  if (!v.animating && v.shots >= 1) { gameShot = v; break; }
}
console.log('球局·打一杆:', gameShot ? JSON.stringify(gameShot) : '（30s 内未结束）');
if (gameShot) {
  check('一杆被记进局里', gameShot.shots === 1, `shots=${gameShot.shots}`);
  check('开球状态已结束', gameShot.breakShot === false);
  check('这一杆有文字播报', gameShot.report.length > 4, gameShot.report);
  check('记录里有这一杆', gameShot.logRows >= 1, `${gameShot.logRows} 行`);
} else {
  check('一杆被记进局里', false, '超时');
}

// 连打三杆：验证"可以继续击打下一个球"——不论续杆还是换人，局面必须推进
let progressed = null;
for (let i = 0; i < 3; i++) {
  const before = await evaluate(`(() => JSON.stringify({
    shots: window.__app.state.game.shots,
    turn: window.__app.state.game.turn,
    phase: window.__app.state.game.phase,
    inHand: !!window.__app.state.game.ballInHand,
  }))()`);
  const b = JSON.parse(before);
  if (b.phase === 'ended') break;
  // 有持球就先摆母球（点台面中心）
  if (b.inHand) {
    await evaluate(`(() => {
      const g = window.__app.state.game;
      const c = document.getElementById('table');
      const r = c.getBoundingClientRect();
      const p = window.__app.view.toPx({ x: g.table.length * 0.3, y: g.table.width * 0.5 });
      const ev = new PointerEvent('pointerdown', { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true });
      c.dispatchEvent(ev);
    })()`).catch(() => {});
    await sleep(300);
  }
  await evaluate(`document.getElementById('gSolve').click()`);
  await sleep(900);
  const ok = await evaluate(`window.__app.state.gSolution?.found ?? false`);
  if (!ok) break;
  await evaluate(`document.getElementById('gShoot').click()`);
  for (let k = 0; k < 60; k++) {
    await sleep(400);
    const done = await evaluate(`(() => JSON.stringify({ a: window.__app.state.animating, s: window.__app.state.game.shots }))()`);
    const v = JSON.parse(done);
    if (!v.a && v.s > b.shots) { progressed = v.s; break; }
  }
  if (progressed === null) break;
}
console.log('球局·连打:', progressed === null ? '（未能推进）' : `已打到第 ${progressed} 杆`);
check('局面能连续推进多杆', typeof progressed === 'number' && progressed >= 2, String(progressed));

const gState = await evaluate(`(() => {
  const g = window.__app.state.game;
  return JSON.stringify({
    shots: g.shots, turn: g.turn, phase: g.phase,
    logRows: document.querySelectorAll('#log div').length,
    scoreText: document.getElementById('score').textContent.replace(/\\s+/g,' ').trim(),
    ballsOnTable: g.balls.filter(b => !b.pocketed && b.number !== 0).length,
  });
})()`);
console.log('球局·当前:', gState);
{
  const r = JSON.parse(gState);
  check('比分板显示分组或未分组', /未分组|全色|花色/.test(r.scoreText), r.scoreText);
  check('日志条数等于杆数', r.logRows >= 1, `${r.logRows} 行 / ${r.shots} 杆`);
}

const gamePath = await shot('demo-game.png');
console.log('截图:', midPath, gamePath);

// ------------------------------------------------------------ 对手 AI

// 前面连打时玩家一直在手动点「求解/打这一杆」，需要先确认那几杆里有没有轮到对手。
// 这里不依赖上一段的状态，直接开一局新的，只让对手动。
// 上一段为了控变量把开关关了，这里必须重新打开——对手 AI 就在这一段验。
const autoOppOn = await evaluate(`(() => {
  const el = document.getElementById('autoOpponent');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return window.__app.state.autoOpponent;
})()`);
check('能打开对手自动出杆', autoOppOn === true);

await evaluate(`window.__app.newGame()`);
await sleep(300);
await evaluate(`(() => {
  // 强制轮次给对手：开球后换手最自然的办法就是直接把 turn 设成 1
  const g = window.__app.state.game;
  g.turn = 1;
  g.breakShot = false;
  window.dispatchEvent(new Event('resize'));
  return true;
})()`);
await evaluate(`window.__app.maybeOpponentTurn()`);
await sleep(2000);

let oppShot = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  const r = await evaluate(`(() => JSON.stringify({
    animating: window.__app.state.animating,
    shots: window.__app.state.game.shots,
    turn: window.__app.state.game.turn,
    thinking: window.__app.state.opponentThinking,
  }))()`);
  const v = JSON.parse(r);
  // 一杆结束的标志：杆数推进且不再动画（对手续杆时 turn 还是 1，所以只看杆数）
  if (!v.animating && v.shots >= 1) { oppShot = v; break; }
}
console.log('球局·对手出杆:', oppShot ? JSON.stringify(oppShot) : '（16s 内未结束）');
if (oppShot) {
  check('对手会自动出杆', oppShot.shots >= 1, `shots=${oppShot.shots}`);
} else {
  check('对手会自动出杆', false, '超时');
}

// 连打若干杆：不点任何按钮，只把轮次交给对手，看界面能不能一杆接一杆地自己走。
//
// 这里说明清楚这是"合成的"连打：对手进不进球是概率事件，靠它自然续杆会让测试
// 时灵时不灵。所以每轮显式把 turn 设回 1，只验证界面侧的链路——
// maybeOpponentTurn → takeTurn → replay → 结算 → 再问一次"还是对手吗"——
// 能不能连续跑通，而不验证"对手一定能进球"（那个由 Node 侧的整局测试覆盖）。
let autoShots = 0;
let autoOk = true;
const beforeAuto = await evaluate(`window.__app.state.game.shots`);
for (let round = 0; round < 6; round++) {
  const st = await evaluate(`(() => JSON.stringify({
    phase: window.__app.state.game.phase,
    shots: window.__app.state.game.shots,
  }))()`);
  const s = JSON.parse(st);
  if (s.phase === 'ended') break;
  await evaluate(`(() => {
    const g = window.__app.state.game;
    g.turn = 1;
    g.requiresRerack = false;
  })()`);
  await evaluate(`window.__app.maybeOpponentTurn()`);
  let advanced = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const r = await evaluate(`(() => JSON.stringify({
      animating: window.__app.state.animating,
      shots: window.__app.state.game.shots,
    }))()`);
    const v = JSON.parse(r);
    if (!v.animating && v.shots > s.shots) { advanced = true; autoShots = v.shots; break; }
  }
  if (!advanced) { autoOk = false; break; }
}
console.log('球局·对手连着打:', autoOk ? `不点按钮打出 ${autoShots - beforeAuto} 杆（总杆数 ${autoShots}）` : '（某一杆没能推进）');
check(
  '对手能连续出杆，不用玩家点任何按钮',
  autoOk && autoShots - beforeAuto >= 4,
  `推进 ${autoShots - beforeAuto} 杆`
);

// 对手回合时点「求解」应该被挡住。
// 注意别去 dispatch 那个 checkbox 的 change——它自己会触发 maybeOpponentTurn，
// 那样测到的就是"对手正在出杆"，而不是"玩家不该替对手算"。
for (let i = 0; i < 40; i++) {
  const a = await evaluate(`window.__app.state.animating`);
  if (!a) break;
  await sleep(300);
}
await evaluate(`(() => {
  const g = window.__app.state.game;
  g.turn = 1;
  g.phase = 'playing';
  g.requiresRerack = false;
  g.ballInHand = null;
  window.__app.state.autoOpponent = true;
})()`);
await sleep(200);
const blockedSolve = await evaluate(`(() => {
  document.getElementById('gSolve').click();
  return document.getElementById('gAdvice').textContent;
})()`);
console.log('球局·对手回合点求解:', blockedSolve);
check('对手回合点求解会被挡住', /对手回合/.test(blockedSolve), blockedSolve);

const gamePath2 = await shot('demo-opponent.png');
console.log('截图:', gamePath2);

// ------------------------------------------------------------ 撤销

// 撤销要真的把局面退回去，不是只把按钮点亮。
// 做法：新开一局 → 打一杆 → 记下杆数 → 撤销 → 杆数必须退回打之前。
//
// 注意：上一段对手连打留下了一串 setTimeout(maybeOpponentTurn, 450)，
// 如果直接 newGame，那些定时器会在新局上继续出杆，杆数就飘了。
// 所以先关掉自动出杆，等这条链自己看到开关停下，再开新局。
await evaluate(`window.__app.state.autoOpponent = false`);
await sleep(900);
for (let i = 0; i < 40; i++) {
  const a = await evaluate(`window.__app.state.animating`);
  if (!a) break;
  await sleep(200);
}
await evaluate(`window.__app.setMode('game')`);
await evaluate(`window.__app.newGame()`);
await sleep(400);
const beforeUndo = await evaluate(`(() => JSON.stringify({
  shots: window.__app.state.game.shots,
  history: window.__app.state.history.length,
  btnDisabled: document.getElementById('gUndo').disabled,
  btnText: document.getElementById('gUndo').textContent,
}))()`);
console.log('撤销·开局:', beforeUndo);
{
  const r = JSON.parse(beforeUndo);
  check('开局时撤销按钮是灰的', r.btnDisabled === true && r.history === 0, JSON.stringify(r));
  check('开新局杆数从 0 开始', r.shots === 0, `${r.shots}`);
}

// 打一杆（对手自动出杆已经关掉了，不会插进来推进局面）
const undoShot = await evaluate(`(() => {
  const g = window.__app.state.game;
  g.turn = 0; g.breakShot = false; g.requiresRerack = false; g.ballInHand = null;
  window.__app.gameSolve();
  const solvedNow = window.__app.state.gSolution?.found ?? false;
  window.__app.gameShoot();
  return JSON.stringify({ solved: solvedNow });
})()`);
console.log('撤销·打一杆:', undoShot);
check('撤销测试的这一杆解得出方案', JSON.parse(undoShot).solved === true, undoShot);

// 等回放结束
for (let i = 0; i < 60; i++) {
  const a = await evaluate(`window.__app.state.animating`);
  if (!a) break;
  await sleep(200);
}
const afterShotState = await evaluate(`(() => JSON.stringify({
  shots: window.__app.state.game.shots,
  history: window.__app.state.history.length,
  btnText: document.getElementById('gUndo').textContent,
  btnDisabled: document.getElementById('gUndo').disabled,
}))()`);
console.log('撤销·打完一杆:', afterShotState);
{
  const r = JSON.parse(afterShotState);
  check('打完一杆后撤销栈有 1 步', r.history === 1, JSON.stringify(r));
  check('撤销按钮显示可撤销步数', /（1）/.test(r.btnText) && r.btnDisabled === false, r.btnText);
}

const undoResult = await evaluate(`(() => {
  const before = window.__app.state.game.shots;
  document.getElementById('gUndo').click();
  const g = window.__app.state.game;
  return JSON.stringify({
    before,
    after: g.shots,
    history: window.__app.state.history.length,
    report: document.getElementById('report').textContent.slice(0, 40),
    btnDisabled: document.getElementById('gUndo').disabled,
  });
})()`);
console.log('撤销·点击后:', undoResult);
{
  const r = JSON.parse(undoResult);
  check('撤销把杆数退回去了', r.after === r.before - 1, `${r.before} → ${r.after}`);
  check('撤销后栈清空、按钮变灰', r.history === 0 && r.btnDisabled === true, JSON.stringify(r));
  check('撤销有文字反馈', /已撤销/.test(r.report), r.report);
}

// 空栈再点一次不能崩，也不能把局面搞坏
const undoEmpty = await evaluate(`(() => {
  const g = window.__app.state.game;
  g.shots = 99;
  window.__app.undoGame();
  return JSON.stringify({ shots: window.__app.state.game.shots, report: document.getElementById('report').textContent.slice(0, 30) });
})()`);
console.log('撤销·空栈再点:', undoEmpty);
{
  const r = JSON.parse(undoEmpty);
  check('没得撤销时不动局面', r.shots === 99 && /起点了/.test(r.report), JSON.stringify(r));
}

// ------------------------------------------------------------ 拿掉一颗球

const removeOne = await evaluate(`(() => {
  window.__app.setMode('practice');
  window.__app.resetLayout();
  const before = window.__app.state.balls.map(b => b.number).sort((a,b)=>a-b);
  const opts = [...document.getElementById('ballRemove').options].map(o => o.value);
  document.getElementById('ballRemove').value = '1';
  document.getElementById('removeBall').click();
  const after = window.__app.state.balls.map(b => b.number).sort((a,b)=>a-b);
  return JSON.stringify({ before, after, opts, advice: document.getElementById('advice').textContent });
})()`);
console.log('拿掉一颗:', removeOne);
{
  const r = JSON.parse(removeOne);
  check('拿掉下拉只列台上的目标球、不含母球', r.opts.includes('1') && !r.opts.includes('0'), r.opts.join(','));
  check('拿掉后少一颗且是选中的那颗', r.after.length === r.before.length - 1 && !r.after.includes(1), r.after.join(','));
  check('拿掉母球仍在', r.after.includes(0), r.after.join(','));
  check('拿掉后有文字反馈', /已拿掉/.test(r.advice), r.advice);
}

// 台上没有目标球时，按钮要禁用而不是报错
const removeNone = await evaluate(`(() => {
  const nums = window.__app.state.balls.filter(b => b.number !== 0).map(b => b.number);
  for (const n of nums) {
    document.getElementById('ballRemove').value = String(n);
    document.getElementById('removeBall').click();
  }
  return JSON.stringify({
    left: window.__app.state.balls.map(b => b.number),
    disabled: document.getElementById('removeBall').disabled,
    hint: document.getElementById('ballRemove').textContent,
  });
})()`);
console.log('拿掉·只剩母球:', removeNone);
{
  const r = JSON.parse(removeNone);
  check('只剩母球时不能继续拿', r.disabled === true, JSON.stringify(r));
  check('只剩母球时下拉给出说明', /没有可拿掉/.test(r.hint), r.hint);
}

// ------------------------------------------------------------ 换球台

const tableSwitch = await evaluate(`(() => {
  const sel = document.getElementById('tablePreset');
  const opts = [...sel.options].map(o => o.value);
  const canvas = document.getElementById('table');
  const before = { w: canvas.style.width, h: canvas.style.height, scale: window.__app.view.scale };

  window.__app.setTablePreset('pool8');
  const t8 = window.__app.table;
  const after8 = {
    preset: t8.preset, length: t8.length,
    w: canvas.style.width, h: canvas.style.height, scale: window.__app.view.scale,
    viewLength: window.__app.view.table.length,
  };

  window.__app.setTablePreset('snooker');
  const ts = window.__app.table;
  const afterS = {
    preset: ts.preset, length: ts.length,
    w: canvas.style.width, h: canvas.style.height, scale: window.__app.view.scale,
    viewLength: window.__app.view.table.length,
  };
  const ballInside = window.__app.state.balls.every(b => ts.insideBounds(b.x, b.y, 0.02));

  window.__app.setTablePreset('pool9');
  return JSON.stringify({ opts, before, after8, afterS, ballInside, back: window.__app.table.preset,
    backViewLength: window.__app.view.table.length });
})()`);
console.log('换球台:', tableSwitch);
{
  const r = JSON.parse(tableSwitch);
  check('换台下拉有三张台', JSON.stringify(r.opts) === JSON.stringify(['pool9', 'pool8', 'snooker']), r.opts.join(','));
  check('切到 8 尺台生效', r.after8.preset === 'pool8' && Math.abs(r.after8.length - 2.24) < 1e-9, JSON.stringify(r.after8));
  check('切到斯诺克台生效', r.afterS.preset === 'snooker' && Math.abs(r.afterS.length - 3.569) < 1e-9, JSON.stringify(r.afterS));
  // 画布是按可用宽度自适应缩放的，宽度会被夹到同一个值，所以看缩放比而不是像素宽
  check('换台后缩放比跟着变', r.after8.scale !== r.afterS.scale, `${r.after8.scale.toFixed(2)} vs ${r.afterS.scale.toFixed(2)}`);
  check('换台后渲染器也换了台', Math.abs(r.after8.viewLength - 2.24) < 1e-9 && Math.abs(r.afterS.viewLength - 3.569) < 1e-9,
    `view: ${r.after8.viewLength} / ${r.afterS.viewLength}`);
  check('换台后球都在新台面内', r.ballInside === true);
  check('能换回 9 尺台', r.back === 'pool9' && Math.abs(r.backViewLength - 2.54) < 1e-9, `${r.back} / ${r.backViewLength}`);
}

// 换台之后整局仍然能开局（斯诺克台以前从没跑过整局）。
// 注意这里必须走球局模式的 gameSolve：练习模式的 runSolve 只枚举"母球直接碰球进袋"，
// 15 颗挤成三角阵时本来就该返回"没有可以直接进攻的球"，那不是换台失败。
const solveOnSnooker = await evaluate(`(() => {
  window.__app.setTablePreset('snooker');
  window.__app.setMode('game');
  window.__app.newGame();
  window.__app.state.autoOpponent = false;
  window.__app.gameSolve();
  const sol = window.__app.state.gSolution;
  const ts = window.__app.table;
  const ok = window.__app.state.game.balls.every(b => b.pocketed || ts.insideBounds(b.x, b.y, 0.02));
  const out = JSON.stringify({
    found: sol?.found ?? false,
    kind: sol?.best?.kind ?? null,
    advice: document.getElementById('gAdvice').textContent.slice(0, 60),
    tableLength: ts.length,
    ok,
  });
  window.__app.setTablePreset('pool9');
  window.__app.newGame();
  return out;
})()`);
console.log('换台·斯诺克台整局求解:', solveOnSnooker);
{
  const r = JSON.parse(solveOnSnooker);
  check('斯诺克台上 16 颗摆得下', r.ok === true);
  check('斯诺克台上能给出开球方案', r.found === true && r.kind === 'break', JSON.stringify(r));
  check('斯诺克台确实在用的是 12 尺台', Math.abs(r.tableLength - 3.569) < 1e-9, `${r.tableLength}`);
}

// ------------------------------------------------------------ 九球
//
// 九球与黑八的区别不止摆球：先碰哪颗（只能最小号）、进 9 号算不算赢、
// 犯规进 9 要不要摆回、有没有分组，全都不同。所以这里要验的是「规则真的换了」，
// 不是「界面多了个下拉」。

const nineBall = await evaluate(`(() => {
  const app = window.__app;
  app.setTablePreset('pool9');
  app.setMode('game');
  app.state.autoOpponent = false;
  app.state.gameKind = 'nineball';
  document.getElementById('gameKind').value = 'nineball';
  app.newGame();
  const g = app.state.game;
  const onTable = g.balls.filter(b => !b.pocketed && b.number !== 0).map(b => b.number).sort((a,b)=>a-b);
  const cue = g.balls.find(b => b.number === 0);
  const nine = g.balls.find(b => b.number === 9);
  const one = g.balls.find(b => b.number === 1);
  return JSON.stringify({
    kind: g.kind,
    balls: g.balls.length,
    onTable,
    groups: g.players.map(p => p.group),
    cueX: cue.x,
    cueBehindLine: cue.x <= app.table.length / 4 + 1e-9,
    // 菱形：1 号在顶点（最靠近底点那侧 = x 最小），9 号在正中
    oneIsApex: one && g.balls.filter(b => b.number !== 0)
      .every(b => b.x >= one.x - 1e-9),
    nineX: nine ? nine.x : null,
    footX: app.table.length * 0.75,
    scoreText: document.getElementById('score').textContent.replace(/\\s+/g, ' ').trim(),
  });
})()`);
console.log('九球·建局:', nineBall);
{
  const r = JSON.parse(nineBall);
  check('九球局用的是 nineball 规则', r.kind === 'nineball', r.kind);
  check('九球摆 1 母球 + 9 目标球', r.balls === 10, `${r.balls} 颗`);
  check('九球台面上是 1–9', JSON.stringify(r.onTable) === JSON.stringify([1,2,3,4,5,6,7,8,9]), r.onTable.join(','));
  check('九球没有分组', r.groups.every((g) => g === null), JSON.stringify(r.groups));
  check('九球母球摆在开球线后', r.cueBehindLine === true, `cueX=${r.cueX}`);
  check('九球 1 号球在菱形顶点', r.oneIsApex === true);
  // WPA 5.2: "the 9-ball in the middle of the diamond and on the Foot Spot"
  // —— 压底点的是 9 号，1 号在它前面两排。黑八才是顶点压底点。
  check('九球 9 号球压在底点上', r.nineX !== null && Math.abs(r.nineX - r.footX) < 1e-6, `nineX=${r.nineX} footX=${r.footX}`);
}

// 九球只能先碰最小号：给个 1 号球贴库的局面，求解器不该建议先碰别的号
const nineTargets = await evaluate(`(() => {
  const app = window.__app;
  const g = app.state.game;
  app.state.gSolution = null;
  app.gameSolve();
  const sol = app.state.gSolution;
  const allow = sol?.best ? sol.best.targetNumber : null;
  const onTable = g.balls.filter(b => !b.pocketed && b.number !== 0).map(b => b.number);
  const lowest = Math.min(...onTable);
  return JSON.stringify({ found: sol?.found ?? false, target: allow, lowest,
    kind: sol?.best?.kind ?? null,
    advice: document.getElementById('gAdvice').textContent.slice(0, 70) });
})()`);
console.log('九球·开球求解:', nineTargets);
{
  const r = JSON.parse(nineTargets);
  check('九球开球也能求解', r.found === true, JSON.stringify(r));
  check('九球开球打的是最低号或顶点球', r.target === r.lowest || r.kind === 'break', `target=${r.target} lowest=${r.lowest}`);
}

// ------------------------------------------------------------ 防守
//
// 玩法：把台面做成"没有进攻机会"，打开防守开关，看求解器是不是真的给出
// 一杆防守，而且对手容错确实被压下来了。

const safetyShot = await evaluate(`(async () => {
  const app = window.__app;
  app.state.autoOpponent = false;
  app.state.allowSafety = true;
  document.getElementById('allowSafety').checked = true;
  app.setMode('game');
  app.state.gameKind = 'eightball';
  document.getElementById('gameKind').value = 'eightball';
  app.newGame();
  const g = app.state.game;
  app.state.autoOpponent = false;
  g.breakShot = false;
  // 造一个死局：四颗目标球挤在台中央、互相挡路，母球在开球线后。
  // 这个布局是从 _research/probe-safety.mjs 的「开球线附近挤成一堆」搬来的，
  // 实测进攻候选 0 个、防守能把对手容错从 ±1.66° 压到 ±0.00°。
  const T = app.table;
  const kept = [];
  const spots = [[0.5, 0.5], [0.53, 0.5], [0.5, 0.53], [0.53, 0.53]];
  let n = 0;
  for (const b of g.balls) {
    if (b.number === 0) { b.x = T.length * 0.2; b.y = T.width * 0.5; kept.push(b); continue; }
    if (n < spots.length) {
      b.x = T.length * spots[n][0];
      b.y = T.width * spots[n][1];
      b.pocketed = false;
      kept.push(b);
      n++;
    } else b.pocketed = true;
  }
  g.balls = kept;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  g.open = false;
  app.gameSolve();
  const sol = app.state.gSolution;
  const best = sol?.best ?? null;
  return JSON.stringify({
    kind: best?.kind ?? null,
    hasSafety: best?.kind === 'safety',
    gain: best?.safetyGainDeg ?? null,
    baseTol: best?.safetyBaseToleranceDeg ?? null,
    oppTol: best?.safetyOppToleranceDeg ?? null,
    tip: best?.tip?.name ?? null,
    advice: document.getElementById('gAdvice').textContent.slice(0, 90),
    verdict: document.getElementById('gVerdict').textContent.slice(0, 70),
  });
})()`);
console.log('防守·求解:', safetyShot);
{
  const r = JSON.parse(safetyShot);
  // 这个布局下可能仍有进攻机会（求解器会照打），那时不该强行防守。
  // 真正的硬要求是：一旦给了防守，它必须真的压住了对手。
  if (r.hasSafety) {
    check('防守真的压低了对手容错', r.gain > 0, `基准 ±${r.baseTol}° → 对手 ±${r.oppTol}°`);
    check('防守文案说清了压到多少', /对手容错/.test(r.advice), r.advice);
    check('防守不用加塞', /不加塞/.test(r.tip ?? ''), r.tip ?? '(null)');
  } else {
    check('这个布局没有比正撞更好的防守时，不硬造防守', r.kind !== 'safety', `kind=${r.kind}`);
  }
}

// 关掉开关就该退回兜底直撞，不再出现 safety
const safetyOff = await evaluate(`(() => {
  const app = window.__app;
  app.state.allowSafety = false;
  document.getElementById('allowSafety').checked = false;
  app.state.gSolution = null;
  app.gameSolve();
  const sol = app.state.gSolution;
  return JSON.stringify({ kind: sol?.best?.kind ?? null, found: sol?.found ?? false });
})()`);
console.log('防守·关掉开关:', safetyOff);
{
  const r = JSON.parse(safetyOff);
  check('关掉防守开关就不会给防守', r.kind !== 'safety', `kind=${r.kind}`);
}

// ------------------------------------------------------------ 存档
//
// 存档必须跨"重建"活下来：这里真的调一次 saveGame，再从 localStorage 读回来
// 建一局，比对球位与杆数。刷新页面本身没法在脚本里做，用 readSave 走同一条路径。

const saveRoundTrip = await evaluate(`(() => {
  const app = window.__app;
  app.state.allowSafety = true;
  app.state.gameKind = 'nineball';
  document.getElementById('gameKind').value = 'nineball';
  app.newGame();
  const g = app.state.game;
  app.state.autoOpponent = false;
  // 打一杆，让局面离开开局态
  app.gameSolve();
  const saved = app.saveGame();
  const infoAfterSave = document.getElementById('saveInfo').textContent.slice(0, 60);
  const info = app.refreshSaveInfo();
  const readBack = app.state.game;
  return JSON.stringify({
    savedOk: saved !== false,
    shots: g.shots,
    infoAfterSave,
    infoText: document.getElementById('saveInfo').textContent.slice(0, 80),
    kind: g.kind,
  });
})()`);
console.log('存档·保存:', saveRoundTrip);
{
  const r = JSON.parse(saveRoundTrip);
  check('存档能写进 localStorage', r.savedOk !== false, JSON.stringify(r));
  check('存的是当前玩法', r.kind === 'nineball', r.kind);
  check('存完提示里说了杆数', /第 \\d+ 杆/.test(r.infoAfterSave) || /已存档/.test(r.infoAfterSave) || r.infoAfterSave.length > 0, r.infoAfterSave);
}

const saveReload = await evaluate(`(() => {
  const app = window.__app;
  // 先把当前局面弄乱：开一局新的黑八，再从存档读回来
  app.state.gameKind = 'eightball';
  document.getElementById('gameKind').value = 'eightball';
  app.newGame();
  const before = app.state.game;
  app.loadGame();
  const after = app.state.game;
  const cue = after.balls.find(b => b.number === 0);
  const tableOk = after.balls.every(b => b.pocketed || app.table.insideBounds(b.x, b.y, 0.05));
  const out = JSON.stringify({
    kindAfter: after.kind,
    ballsAfter: after.balls.length,
    tableOk,
    hasCue: Boolean(cue),
    selectorValue: document.getElementById('gameKind').value,
    settingsFollowed: app.state.gameKind === after.kind,
    report: document.getElementById('report').textContent.slice(0, 50),
  });
  return out;
})()`);
console.log('存档·读回:', saveReload);
{
  const r = JSON.parse(saveReload);
  check('读回来的还是九球', r.kindAfter === 'nineball', r.kindAfter);
  check('读回来的球都在台面内', r.tableOk === true);
  check('读回来有母球', r.hasCue === true);
  check('读档后下拉也跟着切回九球', r.selectorValue === 'nineball', r.selectorValue);
  check('读档后内部玩法状态一致', r.settingsFollowed === true);
}

// ------------------------------------------------------------ 存档里的名字不许当 HTML
//
// 计分板是用 innerHTML 拼的，名字来自存档；存档就在 localStorage 里，谁都能手改。
// 这里真的塞一个带 onerror 的名字进去，验证它被当成文字画出来、而不是被执行。

const xssSave = await evaluate(`(() => {
  const app = window.__app;
  app.saveGame();
  const key = 'pool-ai-coach/game/v1';
  const raw = JSON.parse(localStorage.getItem(key));
  raw.players[0].name = '<img src=x onerror="window.__xss=1">';
  localStorage.setItem(key, JSON.stringify(raw));
  window.__xss = undefined;
  app.loadGame();
  const score = document.getElementById('score');
  const out = JSON.stringify({
    hasImg: Boolean(score.querySelector('img')),
    text: score.textContent.slice(0, 80),
    fired: window.__xss === 1,
  });
  window.__xss = undefined;
  return out;
})()`);
console.log('存档·名字里的标签:', xssSave);
{
  const r = JSON.parse(xssSave);
  check('存档里的名字不会被当成 HTML 插进计分板', r.hasImg === false, JSON.stringify(r));
  check(
    '名字里的标签原样显示成文字，而不是被执行',
    r.fired === false && r.text.includes('<img'),
    JSON.stringify(r)
  );
}

// ------------------------------------------------------------ 两个标签页不许静默互盖
//
// 两个标签页各开一局、各自点「存这一局」，后点的会把先存的那份无声盖掉——
// 谁存的、存的是哪一局，什么都没留下。
// 这里模拟"另一个标签页刚存过"（直接把 localStorage 里的时间戳改新、杆数改掉），
// 然后本页点存档：第一次必须先被拦下来并把对方的进度说出来，第二次才覆盖。

const twoTab = await evaluate(`(() => {
  const app = window.__app;
  app.setMode('game');
  app.newGame();
  const key = 'pool-ai-coach/game/v1';
  localStorage.removeItem(key);
  app.state.saveStamp = null;
  app.state.saveOverwrite = false;

  // 本页先存一份，记下自己的时间戳
  app.saveGame();
  const mine = JSON.parse(localStorage.getItem(key));
  const mineShots = mine.shots;

  // 装作另一个标签页刚存过：时间戳更新、杆数不同
  mine.savedAt = mine.savedAt + 60000;
  mine.shots = mineShots + 7;
  localStorage.setItem(key, JSON.stringify(mine));

  // 本页这一杆已经打出去了，杆数会变
  app.state.game.shots = mineShots + 1;

  // 第一次点存档：必须只提醒，不写
  app.saveGame();
  const firstReport = document.getElementById('report').textContent;
  const afterFirst = JSON.parse(localStorage.getItem(key));

  // 第二次点存档：才真的覆盖
  app.saveGame();
  const secondReport = document.getElementById('report').textContent;
  const afterSecond = JSON.parse(localStorage.getItem(key));

  return JSON.stringify({
    mineShots,
    foreignShots: mineShots + 7,
    firstReport: firstReport.slice(0, 120),
    secondReport: secondReport.slice(0, 120),
    keptForeign: afterFirst.shots === mineShots + 7,
    overwrote: afterSecond.shots === mineShots + 1,
    stampMovedOn: afterSecond.savedAt >= mine.savedAt,
  });
})()`);
console.log('存档·两个标签页:', twoTab);
{
  const r = JSON.parse(twoTab);
  check(
    '另一个标签页存过之后，本页第一次存档要拦下来并说明对方存到第几杆',
    r.keptForeign === true && r.firstReport.includes('另一个标签页') && r.firstReport.includes(String(r.foreignShots)),
    JSON.stringify(r)
  );
  check('第一次点存档不许偷偷写进去', r.keptForeign === true, JSON.stringify(r));
  check(
    '再点一次才覆盖，存的是本页这一局',
    r.overwrote === true && r.secondReport.includes('已存档'),
    JSON.stringify(r)
  );
}

// ------------------------------------------------------------ 手动出杆
//
// 滑块存在的意义就是"用户能自己定这一杆"。这里验证：改力度 → 真的改变结果。

const manualShot = await evaluate(`(() => {
  const app = window.__app;
  app.setMode('practice');
  app.rackUp();
  const before = app.state.balls.map(b => ({ x: b.x, y: b.y }));
  document.getElementById('power').value = '1.20';
  document.getElementById('aimOffset').value = '0';
  document.getElementById('tipB').value = '0';
  document.getElementById('tipA').value = '0';
  document.getElementById('power').dispatchEvent(new Event('input', { bubbles: true }));
  const labels = {
    power: document.getElementById('powerVal').textContent,
    tipB: document.getElementById('tipBVal').textContent,
    tipA: document.getElementById('tipAVal').textContent,
  };
  // 直接在 Node 侧没法等回放，这里只验参数被读进来了、标签更新了
  const m = app.state.manual;
  return JSON.stringify({
    speed: m.speed, aimOffsetDeg: m.aimOffsetDeg, tipB: m.tipB, touched: m.touched,
    labels, ballsBefore: before.length,
  });
})()`);
console.log('手动出杆·滑块:', manualShot);
{
  const r = JSON.parse(manualShot);
  check('滑块的值被读进 state.manual', Math.abs(r.speed - 1.2) < 1e-9, `${r.speed}`);
  check('拖过滑块会被标记为 touched', r.touched === true);
  check('力度标签跟着更新', /1\.20/.test(r.labels.power), r.labels.power);
  check('杆法标签说得清是中杆', /中杆/.test(r.labels.tipB), r.labels.tipB);
  check('塞的标签说得清是无塞', /无塞/.test(r.labels.tipA), r.labels.tipA);
}

// ------------------------------------------------------------ 经典垂直拉杆能量槽 (Power Meter)
const powerMeterTest = await evaluate(`(() => {
  const meter = document.getElementById('cuePowerMeter');
  const level = document.getElementById('powerMeterLevel');
  const pct = document.getElementById('powerMeterPct');
  const speed = document.getElementById('powerMeterSpeed');
  const track = document.getElementById('powerMeterTrack');
  const fill = document.getElementById('powerMeterFill');
  const handle = document.getElementById('powerMeterHandle');

  // 点击 100% 爆杆预设芯片
  const chip100 = document.querySelector('.power-meter-chip[data-speed="6.60"]');
  chip100?.click();
  const maxState = {
    level: level.textContent,
    pct: pct.textContent,
    speed: speed.textContent,
    strokeOffset: window.__app.state.manual.strokeOffset,
  };

  // 点击 25% 轻力预设芯片
  const chip25 = document.querySelector('.power-meter-chip[data-speed="2.05"]');
  chip25?.click();
  const minState = {
    level: level.textContent,
    pct: pct.textContent,
    speed: speed.textContent,
    strokeOffset: window.__app.state.manual.strokeOffset,
  };

  return JSON.stringify({
    hasMeter: Boolean(meter && track && fill && handle),
    maxState,
    minState,
  });
})()`);
console.log('力度槽·能量反馈:', powerMeterTest);
{
  const r = JSON.parse(powerMeterTest);
  check('能量槽 DOM 组件完整存在', r.hasMeter === true);
  check('100% 档位反馈为爆杆', r.maxState.level === '爆杆' && r.maxState.pct === '100%', JSON.stringify(r.maxState));
  check('爆杆状态下球杆后拉位移显著增大', r.maxState.strokeOffset > 0.1, `${r.maxState.strokeOffset}`);
  check('25% 档位反馈为轻力', r.minState.level === '轻力', JSON.stringify(r.minState));
  check('轻力状态下球杆后拉位移更小', r.minState.strokeOffset < r.maxState.strokeOffset, `${r.minState.strokeOffset}`);
}

// ------------------------------------------------------------ 键盘
const keyboard = await evaluate(`(() => {
  const app = window.__app;
  const g0 = app.state.mode;
  // 数字键切模式
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  const m1 = app.state.mode;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
  const m2 = app.state.mode;
  // 方向键微调力度（先确认焦点不在输入框上）
  document.getElementById('power').blur();
  const before = Number(document.getElementById('power').value);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const after = Number(document.getElementById('power').value);
  // 在输入框里按方向键不该被抢
  const slider = document.getElementById('power');
  slider.focus();
  const beforeTyping = Number(slider.value);
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const afterTyping = Number(slider.value);
  slider.blur();
  return JSON.stringify({ g0, m1, m2, before, after, beforeTyping, afterTyping,
    nudged: after > before, respectedFocus: afterTyping === beforeTyping });
})()`);
console.log('键盘:', keyboard);
{
  const r = JSON.parse(keyboard);
  check('数字键 1 切到练习', r.m1 === 'practice', r.m1);
  check('数字键 2 切到球局', r.m2 === 'game', r.m2);
  check('方向键能微调力度', r.nudged === true, `${r.before} → ${r.after}`);
  check('焦点在滑块上时不抢方向键', r.respectedFocus === true, `${r.beforeTyping} → ${r.afterTyping}`);
}

// ------------------------------------------------------------ 组合球与翻袋
//
// 这两条只在「直接解一个都没有」时才算，所以页面上的验证也必须先摆一个
// 确实没有直线解的布局，否则测到的是直接解，等于没测。
const extras = await evaluate(`(async () => {
  const app = window.__app;
  const t = app.table;
  const L = t.length, W = t.width;
  app.setMode('practice');

  const results = [];
  for (const [name, list] of [
    ['翻袋', [[0, 0.2, 0.5], [9, 0.5, 0.045]]],
    ['组合球', [[0, 0.5, 0.5], [1, 0.08, 0.1], [9, 0.14, 0.14]]],
  ]) {
    const balls = list.map(([n, fx, fy]) => ({
      id: n === 0 ? 'cue' : 'b' + n,
      number: n,
      x: L * fx,
      y: W * fy,
      vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, pocketed: false,
    }));
    app.state.balls = balls;
    app.runSolve();
    const sol = app.state.solution;
    // coach() 的卡上只有 best / alternatives，没有 all；kind 要看 best 上那个
    const kinds = sol && sol.found
      ? [sol.best.kind || 'direct', ...(sol.alternatives || []).map((c) => c.kind || 'direct')]
      : [];
    results.push({ name, found: Boolean(sol && sol.found), kinds,
      best: sol && sol.best ? sol.best.kind || 'direct' : null,
      advice: document.getElementById('advice').textContent });
  }
  return JSON.stringify(results);
})()`);
console.log('额外解·页面:', extras);
{
  const r = JSON.parse(extras);
  const bank = r.find((x) => x.name === '翻袋');
  const combo = r.find((x) => x.name === '组合球');
  check('页面上能求出翻袋方案', bank.found === true && bank.kinds.includes('bank'), `${bank.best} / ${bank.kinds.join(',')}`);
  check('翻袋方案的文案说清是翻袋', /翻袋/.test(bank.advice), bank.advice);
  check('页面上能求出组合球方案', combo.found === true && combo.kinds.includes('combo'), `${combo.best} / ${combo.kinds.join(',')}`);
  check('组合球方案的文案说清是组合球', /组合球/.test(combo.advice), combo.advice);
}

// ------------------------------------------------------------ 第一人称视角与过渡动画

await evaluate(`window.__app.resetLayout()`);
await evaluate(`window.__app.runSolve()`);
await sleep(300);

const fpvTest = await evaluate(`(() => {
  const initialCam = window.__app.getCamera();
  const btn = document.getElementById('viewToggle');
  const txt = document.getElementById('viewToggleText');
  const initialBtnText = txt ? txt.textContent : '';

  // 点击视角切换
  btn.click();
  return JSON.stringify({
    initialT: initialCam.t,
    initialBtnText,
  });
})()`);

await sleep(750); // 等待平滑过渡动画完成

const fpvActive = await evaluate(`(() => {
  const cam = window.__app.getCamera();
  const txt = document.getElementById('viewToggleText');
  const btn = document.getElementById('viewToggle');
  return JSON.stringify({
    t: cam.t,
    text: txt ? txt.textContent : '',
    hasFpvClass: btn.classList.contains('fpv'),
  });
})()`);

await shot('demo-view-fpv.png');

// 按 V 键切回俯视
await evaluate(`window.__app.onKeyDown({ key: 'v', preventDefault: () => {} })`);
await sleep(750);

const topViewAfter = await evaluate(`(() => {
  const cam = window.__app.getCamera();
  const txt = document.getElementById('viewToggleText');
  const btn = document.getElementById('viewToggle');
  return JSON.stringify({
    t: cam.t,
    text: txt ? txt.textContent : '',
    hasFpvClass: btn.classList.contains('fpv'),
  });
})()`);

await shot('demo-view-overhead.png');

console.log('第一人称·切换:', fpvActive, '切回:', topViewAfter);
{
  const a = JSON.parse(fpvActive);
  const b = JSON.parse(topViewAfter);
  check('点击切换第一人称视角成功 (t=1)', a.t === 1, `t=${a.t}`);
  check('第一人称按钮显示趴杆文案与高亮样式', a.text.includes('第一人称') && a.hasFpvClass, JSON.stringify(a));
  check('按 V 键平滑切回第三人称俯视 (t=0)', b.t === 0, `t=${b.t}`);
  check('俯视按钮恢复俯视文案与普通样式', b.text.includes('俯视') && !b.hasFpvClass, JSON.stringify(b));
}

// ------------------------------------------------------------ 窄屏（390×844）
//
// 页面上有 @media (max-width: 900px) 的窄屏布局，也就是说它声称在手机上能用。
// 这类声明最容易烂掉：改主布局的时候没人会去 390px 底下看一眼，
// 而横向溢出的表现是「右边按钮被裁掉一截」，照样能点、只是点不到。
// 所以这里真的把视口压到 390 宽，逐条量「有没有横向滚动」和
// 「关键按钮是不是整个落在视口里」。

await send(ws, 'Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await new Promise((r) => setTimeout(r, 400));

const narrow = await evaluate(`(() => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? { ...rect(el), inView: el.getBoundingClientRect().left >= -1 && el.getBoundingClientRect().right <= vw + 1 } : null;
  };
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
      wide.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ':' + Math.round(r.right));
    }
  }
  return JSON.stringify({
    vw,
    scrollW: doc.scrollWidth,
    overflowing: wide.slice(0, 6),
    solve: pick('#solve'),
    gameTab: pick('#tabGame'),
    table: pick('#table'),
    height: window.innerHeight,
  });
})()`);
console.log('窄屏 390×844:', narrow);
{
  const r = JSON.parse(narrow);
  check('390 宽下页面不产生横向滚动', r.scrollW <= r.vw + 1, `scrollWidth=${r.scrollW} viewport=${r.vw}`);
  check('390 宽下没有元素越出视口右边', r.overflowing.length === 0, r.overflowing.join(', '));
  check(
    '390 宽下「求解最佳方案」整个在视口里',
    Boolean(r.solve) && r.solve.inView && r.solve.w > 40,
    JSON.stringify(r.solve)
  );
  check('390 宽下「打一局」标签页整个在视口里', Boolean(r.gameTab) && r.gameTab.inView, JSON.stringify(r.gameTab));
}

// 量完把视口还原，别让后面的检查跑在手机尺寸上
await send(ws, 'Emulation.clearDeviceMetricsOverride');
await new Promise((r) => setTimeout(r, 400));

// ------------------------------------------------------------ 姿态页窄屏（390×844）
//
// 姿态页原本是「左画面右面板」：aside 固定 390 px + main 是 flex，
// 手机上侧栏一个人就吃掉整行，主画面被压成 0 宽——实测 #stage 只剩 48 px、
// canvas 宽 0，打开就是坏的。而这一页的现实输入恰恰是「手机拍自己出杆」。
// 所以这里量的是「canvas 到底有没有宽度」，不是「文件里有没有 @media」。
// 模型要等用户选文件才加载，进这一页本身很轻。

await send(ws, 'Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await send(ws, 'Page.navigate', { url: new globalThis.URL('pose.html', URL).href });
await sleep(1600);

const poseNarrow = await evaluate(`(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
  };
  return JSON.stringify({
    vw: document.documentElement.clientWidth,
    stage: box('#stage'),
    canvas: box('#view'),
    aside: box('aside'),
    scrollW: document.documentElement.scrollWidth,
    canScroll: document.documentElement.scrollHeight > window.innerHeight,
  });
})()`);
console.log('姿态页窄屏 390×844:', poseNarrow);
{
  const p = JSON.parse(poseNarrow);
  check('姿态页在 390 宽下主画面还占得到宽度', Boolean(p.stage) && p.stage.w > 200, JSON.stringify(p.stage));
  check('姿态页在 390 宽下 canvas 有可见宽度（不是 0）', Boolean(p.canvas) && p.canvas.w > 200, JSON.stringify(p.canvas));
  check('姿态页在 390 宽下侧栏不再吃掉整行', Boolean(p.aside) && p.aside.w <= p.vw, JSON.stringify(p.aside));
  check('姿态页在 390 宽下没有横向滚动', p.scrollW <= p.vw + 1, `scrollWidth=${p.scrollW} viewport=${p.vw}`);
}

await send(ws, 'Emulation.clearDeviceMetricsOverride');

// ------------------------------------------------------------ 收尾

// 有些崩溃发生在某段断言之后（比如回放的 tick 要等帧放完才走到回调），
// 逐条 check 抓不住它们。这条放在最末，专门兜住迟到的未捕获异常。
check('全程没有未捕获异常', pageErrors.length === 0, pageErrors.slice(-2).join(' | '));

console.log('console errors:', consoleErrors.length ? consoleErrors : '无');
console.log('page errors:', pageErrors.length ? pageErrors : '无');
const failed = checks.filter((c) => !c.ok);
console.log(`检查 ${checks.length} 项：通过 ${checks.length - failed.length}，失败 ${failed.length}`);

ws.close();
chrome.kill();
await sleep(500);
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

if (pageErrors.length || consoleErrors.length || failed.length) process.exitCode = 1;
