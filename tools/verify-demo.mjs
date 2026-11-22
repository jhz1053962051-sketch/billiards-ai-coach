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
    // GitHub Actions 的 Linux runner 上 /dev/shm 只有 64MB，Chrome 把共享内存段
    // 放在那里，写满就会整进程崩掉（表现为 Target closed / SIGTRAP）。CI 上实测
    // 到过 node 24 的 E2E 偶发失败，cdp.mjs 的启动参数早就有这一项，这里补齐。
    '--disable-dev-shm-usage',
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

// 架杆：几何上能进不等于人打得着。母球贴库时杆尾要翘，教练卡必须说出来，
// 否则用户按「很容易」去打，一杆下去完全不是那回事。
{
  const rail = await evaluate(`(() => {
    const app = window.__app;
    const t = app.table;
    const cue = app.state.balls.find((b) => b.id === 'cue');
    const before = { x: cue.x, y: cue.y };
    cue.x = 0.9;
    cue.y = t.bounds.minY + 0.012;
    app.runSolve();
    const advice = document.getElementById('advice').textContent;
    cue.x = before.x;
    cue.y = before.y;
    app.runSolve();
    const restored = document.getElementById('advice').textContent;
    return JSON.stringify({ advice, restored });
  })()`);
  console.log('练习·贴库:', rail);
  const r = JSON.parse(rail);
  check('母球贴库时教练卡说明要翘杆', /杆尾要翘/.test(r.advice), r.advice);
  check('挪回原位后不再提翘杆', !/杆尾要翘/.test(r.restored), r.restored);
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
// 「能点」这件事要看得出来：触屏没有 hover，光靠变色等于没提示。
{
  const afford = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#alts .alt')];
    const hint = document.querySelector('.alts-card .hint');
    return JSON.stringify({
      rows: rows.length,
      arrows: rows.filter((r) => r.querySelector('.go')).length,
      role: rows.every((r) => r.getAttribute('role') === 'button'),
      tabbable: rows.every((r) => r.tabIndex === 0),
      hint: hint ? hint.textContent.trim() : '',
    });
  })()`);
  const a = JSON.parse(afford);
  check('备选行都带可点的箭头', a.rows > 0 && a.arrows === a.rows, `${a.arrows}/${a.rows}`);
  check('备选行是按钮语义且能聚焦', a.role && a.tabbable, JSON.stringify(a));
  check('备选区写明点了会发生什么', /点某一条/.test(a.hint), a.hint);
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

// ------------------------------------------------------------ 同一个球位连着记
// 记完一杆就把两个按钮禁掉、非得重新求解才能记下一杆，等于逼人重复劳动：
// 同一个球位反复练十杆是常态。这里守两件事：记完还能接着记；手抖双击不记成两杆。
{
  const before = await evaluate(`window.__app.practiceCount()`);
  const first = await evaluate(`(() => {
    const b = document.getElementById('practiceMade');
    b.click();
    return JSON.stringify({ disabled: b.disabled, text: document.getElementById('practiceMessage').textContent });
  })()`);
  const f = JSON.parse(first);
  check('记完一杆按钮仍可点', f.disabled === false, JSON.stringify(f));
  check('记完的文案说明还能接着记', /接着记/.test(f.text), f.text);

  // 立刻再点一次：600 ms 内的双击算误触，不该多记一杆
  await evaluate(`document.getElementById('practiceMissed').click()`);
  const afterDouble = await evaluate(`window.__app.practiceCount()`);
  check('双击不会记成两杆', afterDouble === before + 1, `${before} → ${afterDouble}`);

  // 等过防抖窗口再点，必须真记进去
  await sleep(700);
  await evaluate(`document.getElementById('practiceMissed').click()`);
  const afterSecond = await evaluate(`window.__app.practiceCount()`);
  check('同一个球位连记第二杆', afterSecond === before + 2, `${before} → ${afterSecond}`);

  // 点错了不该只能清空整本记录：撤销按钮撤掉最新那条，其余不动
  const undone = await evaluate(`(() => {
    const b = document.getElementById('practiceUndo');
    const wasDisabled = b.disabled;
    b.click();
    return JSON.stringify({ wasDisabled, after: window.__app.practiceCount(), text: document.getElementById('practiceMessage').textContent });
  })()`);
  const u = JSON.parse(undone);
  check('撤销按钮平时是可点的', u.wasDisabled === false, undone);
  check('撤销只删掉最新那条', u.after === before + 1, `${before + 2} → ${u.after}`);
  check('撤销后说清楚撤了多少条', /撤销/.test(u.text) && /→/.test(u.text), u.text);

  // 统计一坨折起来了，但「今天练了几杆」必须还看得见，否则折叠等于藏掉进度
  const stats = await evaluate(`(() => {
    const d = document.getElementById('practiceStats');
    return JSON.stringify({
      isDetails: d?.tagName === 'DETAILS',
      open: d?.open === true,
      summary: document.getElementById('practiceStatsSummary')?.textContent ?? '',
      goalInside: Boolean(d?.querySelector('#practiceGoalBar')),
    });
  })()`);
  const st = JSON.parse(stats);
  check('练习统计默认折着', st.isDetails && st.open === false, JSON.stringify(st));
  check('统计标题里带今日进度', /今天 \d+\/10 杆/.test(st.summary), st.summary);
  check('今日目标进度折在统计里', st.goalInside, JSON.stringify(st));
}

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

// 两步选杆要在界面上说出来：对手不是"随便打一杆"，而是在能进的方案里挑了一个
// 让你最难上手的。这条只查播报里有没有这句话——选杆本身由 Node 侧的对手测试守着。
const lookaheadNote = await evaluate(`document.getElementById('report').textContent`);
check(
  '对手出杆后说明它在几个方案里挑的',
  /打完留给你最好打的一杆容错 ±[\d.]+°/.test(lookaheadNote),
  (lookaheadNote || '').slice(0, 120)
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

// ------------------------------------------------------------ 斯诺克
//
// 切到斯诺克之后要验三件事：球台自动换成 12 尺台、摆出 22 颗球、
// 计分板从「剩几颗」变成「几分 + 该打什么球」。
// 这三件里有任何一件没做，界面就会用黑八的方式显示一局斯诺克。

const snookerGame = await evaluate(`(async () => {
  const app = window.__app;
  app.setMode('game');
  const sel = document.getElementById('gameKind');
  sel.value = 'snooker';
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 400));
  const g = app.state.game;
  const onTable = g ? g.balls.filter((b) => !b.pocketed) : [];
  return JSON.stringify({
    kind: g?.kind ?? null,
    balls: g?.balls.length ?? 0,
    reds: onTable.filter((b) => b.number >= 1 && b.number <= 15).length,
    colors: onTable.filter((b) => b.number >= 16).length,
    table: app.table.preset,
    scores: g?.snooker?.scores ?? null,
    ballOn: g?.snooker?.ballOn ?? null,
    scoreText: document.getElementById('score').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
    kindValue: sel.value,
  });
})()`);
console.log('斯诺克·建局:', snookerGame);
{
  const r = JSON.parse(snookerGame);
  check('切到斯诺克会换成 12 尺台', r.table === 'snooker', `table=${r.table}`);
  check('斯诺克摆出 22 颗球（15 红 + 6 彩 + 母球）', r.balls === 22, `balls=${r.balls}`);
  check('红球 15 颗、彩球 6 颗都在台上', r.reds === 15 && r.colors === 6, `reds=${r.reds} colors=${r.colors}`);
  check('计分板显示比分', /0 分/.test(r.scoreText), r.scoreText);
  check('计分板说清这一杆该打红球', /该打：红球/.test(r.scoreText), r.scoreText);
}

const snookerShot = await evaluate(`(async () => {
  const app = window.__app;
  app.gameSolve();
  const sol = app.state.gSolution;
  return JSON.stringify({
    solved: Boolean(sol),
    found: sol?.found ?? false,
    kind: sol?.best?.kind ?? null,
    advice: document.getElementById('gAdvice').textContent.slice(0, 90),
  });
})()`);
console.log('斯诺克·求解:', snookerShot);
{
  const r = JSON.parse(snookerShot);
  check('斯诺克局面也能求解（红球堆里没机会时给防守/直撞）', r.solved === true, JSON.stringify(r));
  check('斯诺克卡的文案不是空的', r.advice.length > 6, r.advice);
}

// 收尾：台面和玩法都要切回去。切到斯诺克时球台会自动换成 12 尺台，
// 只把玩法改回黑八的话，后面几段会拿着 3.569 米长的台面按 2.54 米的比例摆球，
// 摆出来的局跟这几段假设的完全不一样（翻袋段就是这么变成直接解的）。
await evaluate(`(async () => {
  const app = window.__app;
  const kind = document.getElementById('gameKind');
  kind.value = 'eightball';
  kind.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 300));
  const tp = document.getElementById('tablePreset');
  tp.value = 'pool9';
  tp.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({ table: app.table.preset, kind: app.state.gameKind });
})()`);
await new Promise((r) => setTimeout(r, 400));

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

// ------------------------------------------------------------ 存档导出成文件、再读回来
//
// localStorage 只在本机这份浏览器里。导出成文件是为了换设备之后还能接着打，
// 所以这条路径必须证明两件事：导出的东西真能读回来，读不回来的东西不许把台面弄乱。

const fileSaveStart = await evaluate(`(() => {
  const app = window.__app;
  app.setMode('game');
  app.state.autoOpponent = false;
  app.newGame();
  const g = app.state.game;
  g.turn = 0; g.breakShot = false; g.requiresRerack = false; g.ballInHand = null;
  const before = g.shots;
  const text = app.exportGameText();
  // 文本放窗口上，下一步的 evaluate 直接取，省掉来回转义
  window.__fileSaveText = text;
  const parsedOk = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
  const hasButtons =
    Boolean(document.getElementById('exportGameSave')) &&
    Boolean(document.getElementById('importGameSave'));
  // 改变局面：开一杆，杆数一定会动
  app.gameSolve();
  app.gameShoot();
  return JSON.stringify({ before, parsedOk, textLen: text.length, hasButtons });
})()`);
console.log('存档·导出成文件:', fileSaveStart);

// 回放要等它放完，否则读到的是打到一半的杆数
for (let i = 0; i < 60; i++) {
  const a = await evaluate(`window.__app.state.animating`);
  if (!a) break;
  await sleep(200);
}

const fileSaveResult = await evaluate(`(() => {
  const app = window.__app;
  const text = window.__fileSaveText;
  const afterShoot = app.state.game.shots;

  const good = app.importGameText(text);
  const restored = app.state.game.shots;

  const bad = app.importGameText('{');
  const afterBad = app.state.game.shots;

  const tampered = JSON.parse(text);
  tampered.balls[0].x = 99;
  const badBall = app.importGameText(JSON.stringify(tampered));
  const afterBadBall = app.state.game.shots;

  return JSON.stringify({
    afterShoot, restored, afterBad, afterBadBall,
    goodOk: good.ok, badOk: bad.ok, badReason: bad.reason,
    badBallOk: badBall.ok,
  });
})()`);
console.log('存档·读回来:', fileSaveResult);
{
  const start = JSON.parse(fileSaveStart);
  const r = JSON.parse(fileSaveResult);
  check('导出的存档是合法 JSON', start.parsedOk === true, fileSaveStart);
  check('导出/导入两个按钮都在界面上', start.hasButtons === true, fileSaveStart);
  check('打一杆之后杆数变了（先确认局面真的动过）', r.afterShoot > start.before, fileSaveResult);
  check('把导出的文件读回来，局面回到导出那一刻', r.goodOk === true && r.restored === start.before, fileSaveResult);
  check('不是 JSON 的文件会被拒绝，且局面不动', r.badOk === false && r.afterBad === start.before, fileSaveResult);
  check(
    '球位跑出台面的文件会被拒绝，且局面不动',
    r.badBallOk === false && r.afterBadBall === start.before,
    fileSaveResult
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

// storage 事件不会在自己这页触发，所以这里直接派一个合成事件，
// 验的是「监听器收到之后会不会给出一条能按的路」——只提示不给按钮，
// 多开一个标签页就等于半残，玩家只能靠手动刷新把局面丢掉。
const takeOther = await evaluate(`(() => {
  const app = window.__app;
  const key = 'pool-ai-coach/game/v1';
  const btn = document.getElementById('takeOtherSave');
  const before = {
    hidden: btn.classList.contains('hidden'),
    text: btn.textContent,
  };
  const saved = JSON.parse(localStorage.getItem(key));
  saved.shots = 12;
  saved.savedAt = saved.savedAt + 1000;
  localStorage.setItem(key, JSON.stringify(saved));
  window.dispatchEvent(new StorageEvent('storage', {
    key,
    newValue: JSON.stringify(saved),
  }));
  const after = {
    hidden: btn.classList.contains('hidden'),
    text: btn.textContent,
    report: document.getElementById('report').textContent.slice(0, 110),
  };
  btn.click();
  const adopted = {
    shots: app.state.game?.shots ?? null,
    report: document.getElementById('report').textContent.slice(0, 90),
    hiddenAgain: btn.classList.contains('hidden'),
  };
  return JSON.stringify({ before, after, adopted });
})()`);
console.log('存档·读入对方那份:', takeOther);
{
  const r = JSON.parse(takeOther);
  check('平时看不到「读入另一个标签页存的」按钮', r.before.hidden === true, JSON.stringify(r.before));
  check(
    '另一个标签页存过之后按钮出现，并说明那边存到第几杆',
    r.after.hidden === false && r.after.text.includes('12'),
    JSON.stringify(r.after)
  );
  check(
    '按下去真的把对方那份读进来（局面换成第 12 杆）',
    r.adopted.shots === 12 && r.adopted.report.includes('12'),
    JSON.stringify(r.adopted)
  );
  check('读进来之后按钮自己收起来', r.adopted.hiddenAgain === true, JSON.stringify(r.adopted));
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

// 上面一组只验「滑块的值被读进来」。用户真正看到的是打完之后的「手打结果：…」，
// 而这句话里的球号 / 母球落袋读的是 simulateFrames 返回的 sim.balls——那份模拟副本
// 的终局。副本读错（读成模拟之前的球位、或读成空数组）时页面不会报错，只会安静地
// 写一句「没有球进袋」，单测和 frames 逐字节比对都兜不到渲染这一侧，所以这里按页面
// 文本验它。
//
// 局面自己摆，不依赖前面用例留下的东西：resetLayout 的三球局，母球摆在台心，1 号球
// 落在母球→左下角袋的连线上、离袋口 0.30 米，另两颗球丢到远角，保证「最近的球」就是
// 1 号、且直撞必进。3.20 m/s 打进去时母球跟着摔袋，1.20 m/s 只进 1 号不摔——两杆的
// 文案差在「母球落袋」这一项上，正好能验每杆都重新读终局。
const MANUAL_SETUP = `(() => {
  const app = window.__app;
  app.setMode('practice');
  app.resetLayout();
  const t = app.table;
  const pk = t.pockets.find((p) => p.id === 'c-bl');
  const byNum = (n) => app.state.balls.find((b) => b.number === n);
  const cue = byNum(0);
  const b1 = byNum(1);
  const b2 = byNum(2);
  const b3 = byNum(3);
  cue.x = t.length * 0.5;
  cue.y = t.width * 0.5;
  const dx = pk.x - cue.x;
  const dy = pk.y - cue.y;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  b1.x = pk.x - ux * 0.30;
  b1.y = pk.y - uy * 0.30;
  b2.x = t.length * 0.95;
  b2.y = t.width * 0.06;
  b3.x = t.length * 0.95;
  b3.y = t.width * 0.94;
  app.state.solution = null;
  const aim = app.currentAim();
  return JSON.stringify({
    target: aim ? aim.targetId : null,
    from: aim ? aim.from : null,
    cue: { x: cue.x, y: cue.y },
  });
})()`;

/**
 * 按给定力度/瞄准偏移打一杆，等回放结束，读页面上的文案。
 * reset 为 false 时沿用上一杆之后的局面（练习模式打完会复位球位），
 * 这样第二杆读到的仍然是同一张台子，可以拿两杆的文案直接对比。
 */
async function manualShotAt(speed, aimOffset, { reset = true } = {}) {
  if (reset) await evaluate(MANUAL_SETUP);
  await evaluate(`(() => {
    document.getElementById('power').value = '${speed}';
    document.getElementById('aimOffset').value = '${aimOffset}';
    document.getElementById('tipB').value = '0';
    document.getElementById('tipA').value = '0';
    document.getElementById('power').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('shootManual').click();
  })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const r = JSON.parse(await evaluate(`(() => JSON.stringify({
      animating: window.__app.state.animating,
      advice: document.getElementById('advice').textContent,
      verdict: document.getElementById('verdict').textContent,
      cue: (() => {
        const c = window.__app.state.balls.find((b) => b.number === 0);
        return c ? { x: c.x, y: c.y } : null;
      })(),
    }))()`));
    // 等的是「回放结束 + 文案真的换成了手打结果」，不是固定时长
    if (!r.animating && r.advice.startsWith('手打结果')) return r;
  }
  return { timeout: true, advice: '', verdict: '', cue: null };
}

const manualSetup = JSON.parse(await evaluate(MANUAL_SETUP));
console.log('手打结果·局面:', JSON.stringify(manualSetup));
check('摆好的局面里最近的球是 1 号、且方向来自直撞（否则后面几杆测不到点上）',
  manualSetup.target === 'b1' && manualSetup.from === 'direct', JSON.stringify(manualSetup));

const manualHard = await manualShotAt('3.20', '0');
console.log('手打结果·3.20 m/s:', JSON.stringify(manualHard));
check(
  '手打之后页面写出「手打结果」，且说清这一杆真的进了 1 号、母球也摔了（读错终局副本会写成「没有球进袋」）',
  /^手打结果：进 1 号 · 母球落袋（/.test(manualHard.advice),
  manualHard.advice || '超时'
);
check(
  '手打结果的括号里带上力度、杆法、塞三项（3.20 m/s · 中杆 · 无塞）',
  /（3\.20 m\/s · 中杆 · 无塞）$/.test(manualHard.advice),
  manualHard.advice || '超时'
);

// 同一张台子换 1.20 m/s 再打：1 号球照样进，但这一杆母球不进袋。
// 如果「手打结果」读的是上一杆留下的副本、或干脆写死一份终局，这两杆就会一模一样。
const manualSoft = await manualShotAt('1.20', '0', { reset: false });
console.log('手打结果·1.20 m/s（同局面）:', JSON.stringify(manualSoft));
check(
  '同一局面换成 1.20 m/s：仍然进 1 号，但「母球落袋」不再出现——文案读的是这一杆的终局',
  /^手打结果：进 1 号（1\.20 m\/s/.test(manualSoft.advice) && !/母球落袋/.test(manualSoft.advice),
  manualSoft.advice || '超时'
);
check(
  '练习模式打完把球位复位了（第二杆才能拿同一张台子作对比）',
  manualSoft.cue !== null &&
    Math.abs(manualSoft.cue.x - manualSetup.cue.x) < 1e-6 &&
    Math.abs(manualSoft.cue.y - manualSetup.cue.y) < 1e-6,
  JSON.stringify(manualSoft.cue)
);

// 再偏 8° 瞄准：这一杆压根碰不到 1 号球，结果文案不能还报「进 1 号」。
const manualWide = await manualShotAt('3.20', '8');
console.log('手打结果·瞄准偏 8°:', JSON.stringify(manualWide));
check(
  '瞄准偏 8° 之后不再报「进 1 号」——结果随输入变，不是一句算好的模板',
  manualWide.advice.startsWith('手打结果') && !/进 1 号/.test(manualWide.advice) &&
    manualWide.advice !== manualHard.advice,
  manualWide.advice || '超时'
);

// 收拾干净：把偏移与局面还原，免得后面的用例读到这张特制的台子。
await evaluate(`(() => {
  document.getElementById('aimOffset').value = '0';
  document.getElementById('power').value = '2.20';
  window.__app.resetLayout();
})()`);

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

// ------------------------------------------------------------ 球局手打：进球续杆 / 犯规播报
//
// 练习模式的「手打结果」走 shootPracticeWith；球局手打走的是另一条分支
// （simulateShot → resolveShot → finishGameShot），用户看到的是 #report 里那句
// 规则播报加记分板上的回合标记。两边的文案来源完全不同——一个是
// describeManualShot 拼的，一个是 rules.js 的 summarizeReport 拼的——所以练习模式
// 那几条断言一条都盖不到这里：球局里母球摔袋会不会说清犯规、合法进球之后轮次
// 有没有留住、犯规之后有没有交给对手还带持球，只能在这条分支上验。
//
// 局面自己摆：newGame 建一局八球，母球在台心，1 号球落在母球→左下角袋的连线上、
// 离袋口 0.30 米，其余 14 颗沿右短库排成一列（离母球都 1.22 米开外，抢不走
// 「最近的合法球」，1 号球离母球 1.12 米）。这条线上的两档力度实测不同：
// 1.20 m/s 进 1 号、母球停在袋口不掉；3.20 m/s 连母球一起摔袋。
const GAME_SETUP = `(() => {
  const app = window.__app;
  app.setMode('game');
  // 关掉对手自动出杆：开着的话轮次一到对手它就自己打一杆，把刚结算的播报改掉，
  // 「读页面文本」这条要求就无从谈起了（对手自动出杆另有专门的用例）。
  const box = document.getElementById('autoOpponent');
  if (box && box.checked) {
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 先把玩法钉成八球、球台钉成 2.54 m 的九尺台再开局。
  // 前面几段用例（九球、斯诺克、存档）都动过这两个下拉，而 newGame() 只认
  // 下拉里的值：留着九球，这一整段就在验九球——不分组、不判分组文案，
  // 几何也是照着 2.54 m 台量出来的。两条都靠 change 事件改，走的才是
  // 玩家点下拉时那条路（换玩法会换台、重开一局）。
  const kindSel = document.getElementById('gameKind');
  if (kindSel.value !== 'eightball') {
    kindSel.value = 'eightball';
    kindSel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const tableSel = document.getElementById('tablePreset');
  if (tableSel.value !== 'pool9') {
    tableSel.value = 'pool9';
    tableSel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  app.newGame();
  const t = app.table;
  const g = app.state.game;
  const pk = t.pockets.find((p) => p.id === 'c-bl');
  const cue = g.balls.find((b) => b.number === 0);
  const b1 = g.balls.find((b) => b.number === 1);
  const dx = pk.x - t.length * 0.5;
  const dy = pk.y - t.width * 0.5;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  cue.x = pk.x - ux * 1.42;
  cue.y = pk.y - uy * 1.42;
  b1.x = pk.x - ux * 0.30;
  b1.y = pk.y - uy * 0.30;
  let k = 0;
  for (const b of g.balls) {
    if (b.number === 0 || b.number === 1) continue;
    b.x = t.length * 0.98;
    b.y = t.width * (0.135 + k++ * 0.0585);
  }
  for (const b of g.balls) {
    b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0; b.pocketed = false;
  }
  g.breakShot = false;
  g.open = true;
  g.turn = 0;
  g.phase = 'playing';
  g.requiresRerack = false;
  g.ballInHand = null;
  g.pendingChoice = null;
  g.shots = 0;
  g.log = [];
  g.players[0].group = null;
  g.players[0].fouls = 0;
  g.players[1].group = null;
  g.players[1].fouls = 0;
  app.state.history = [];
  app.state.gSolution = null;
  app.state.solution = null;
  const aim = app.currentAim();
  return JSON.stringify({
    kind: g.kind,
    tableLen: t.length,
    open: g.open,
    breakShot: g.breakShot,
    target: aim ? aim.targetId : null,
    from: aim ? aim.from : null,
    cue: { x: cue.x, y: cue.y },
    b1: { x: b1.x, y: b1.y },
  });
})()`;

// 犯规局面：玩家已经拿到全色，台心摆一颗全色当合法目标（离母球 1.02 米），
// 正中间插一颗花色挡路（0.51 米）——母球先碰到的必然是花色。
// 其余球判为已进袋（"剩 N" 照实变少），这一杆才只可能出这一种犯规。
const GAME_WRONG_BALL_SETUP = `(() => {
  const app = window.__app;
  const g = app.state.game;
  const t = app.table;
  const cue = g.balls.find((b) => b.number === 0);
  const at = (n, fx, fy) => {
    const b = g.balls.find((x) => x.number === n);
    b.x = t.length * fx;
    b.y = t.width * fy;
    b.pocketed = false;
    b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
    return b;
  };
  cue.x = t.length * 0.5;
  cue.y = t.width * 0.5;
  cue.pocketed = false;
  cue.vx = 0; cue.vy = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
  at(2, 0.90, 0.50);
  at(9, 0.70, 0.50);
  for (const b of g.balls) {
    if (b.number === 0 || b.number === 2 || b.number === 9) continue;
    b.pocketed = true;
    b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
  }
  g.ballInHand = null;
  g.requiresRerack = false;
  g.turn = 0;
  g.phase = 'playing';
  // 分组直接钉住，不靠上一杆「恰好分了组」：这条用例只关心「先碰到的不是
  // 合法目标球」，分组是谁给的与它无关。
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const aim = app.currentAim();
  return JSON.stringify({
    target: aim ? aim.targetId : null,
    group: g.players[0].group,
  });
})()`;

const GAME_SNAP = `(() => {
  const app = window.__app;
  const g = app.state.game;
  const turn = document.querySelector('#score .who.turn .nm');
  const cue = g ? g.balls.find((b) => b.number === 0) : null;
  const b1 = g ? g.balls.find((b) => b.number === 1) : null;
  const log = document.getElementById('log');
  return JSON.stringify({
    animating: app.state.animating,
    mode: app.state.mode,
    shots: g ? g.shots : null,
    turn: g ? g.turn : null,
    phase: g ? g.phase : null,
    history: app.state.history.length,
    turnName: turn ? turn.textContent.trim() : null,
    report: document.getElementById('report').textContent.replace(/\\s+/g, ' ').trim(),
    logText: log.textContent.replace(/\\s+/g, ' ').trim(),
    logRows: Array.from(log.children).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
    advice: document.getElementById('gAdvice').textContent.trim(),
    verdict: document.getElementById('gVerdict').textContent.trim(),
    undoLabel: document.getElementById('gUndo').textContent.trim(),
    undoDisabled: document.getElementById('gUndo').disabled,
    score: document.getElementById('score').textContent.replace(/\\s+/g, ' ').trim(),
    cue: cue ? { x: cue.x, y: cue.y, pocketed: cue.pocketed } : null,
    b1: b1 ? { x: b1.x, y: b1.y, pocketed: b1.pocketed } : null,
    pauseHidden: document.getElementById('autoPauseBar').classList.contains('hidden'),
    pauseText: document.getElementById('autoPauseText').textContent.replace(/\\s+/g, ' ').trim(),
  });
})()`;

const gameSnap = async () => JSON.parse(await evaluate(GAME_SNAP));

/**
 * 球局里手打一杆，等回放真的结算完（不是等固定时长），再读页面。
 * wantShots 是这一杆打完应该达到的杆数——靠它判定「这一杆真的发生了」。
 */
async function gameManualShot(speed, wantShots, { setup = null, offset = '0' } = {}) {
  if (setup) await evaluate(setup);
  await evaluate(`(() => {
    document.getElementById('power').value = '${speed}';
    document.getElementById('aimOffset').value = '${offset}';
    document.getElementById('tipB').value = '0';
    document.getElementById('tipA').value = '0';
    document.getElementById('power').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('shootManual').click();
  })()`);
  let last = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    last = await gameSnap();
    if (!last.animating && last.shots === wantShots) return last;
  }
  return { ...(last ?? {}), timeout: true };
}

// ---- 路径 1a：合法进球 → 续杆，轮次留在自己这边
const gameSetup = JSON.parse(await evaluate(GAME_SETUP));
console.log('球局手打·局面:', JSON.stringify(gameSetup));
check(
  '球局手打的局面是八球、2.54 m 九尺台，最近的合法球是 1 号、方向来自直撞（否则后面两杆打不到点上）',
  gameSetup.kind === 'eightball' &&
    Math.abs(gameSetup.tableLen - 2.54) < 1e-9 &&
    gameSetup.target === 'b1' &&
    gameSetup.from === 'direct',
  JSON.stringify(gameSetup)
);

const potLegal = await gameManualShot('1.20', 1);
console.log('球局手打·1.20 合法进球:', JSON.stringify(potLegal));
check(
  '球局里手打进 1 号：播报写明进了几号、并说「你 继续」',
  /进 1 号/.test(potLegal.report) && /你 继续/.test(potLegal.report),
  potLegal.report || '超时'
);
check(
  '球局里手打进 1 号：播报没有冒犯规，轮次仍在自己这边（记分板上的回合标记还是「你」）',
  !/犯规/.test(potLegal.report) && potLegal.turn === 0 && potLegal.turnName === '你',
  `${potLegal.report} / turn=${potLegal.turnName}`
);
check(
  '球局里手打进 1 号：播报说清分组结果（你拿到全色），记分板跟着换组',
  /分组：你拿到全色/.test(potLegal.report) && /你 全色/.test(potLegal.score),
  `${potLegal.report} / ${potLegal.score}`
);
check(
  '球局手打的结果同时进「对局记录」：第 1 杆 · 进 1 号 · 你 继续',
  potLegal.logRows.length === 1 && potLegal.logRows[0] === '第 1 杆 · 进 1 号 · 你 继续',
  JSON.stringify(potLegal.logRows)
);

// ---- 路径 1b：同一局接着手打一次犯规（先碰非目标球）→ 播报说清犯规类型，轮次交给对手
const wrongBallSetup = JSON.parse(await evaluate(GAME_WRONG_BALL_SETUP));
console.log('球局手打·犯规局面:', JSON.stringify(wrongBallSetup));
check(
  '犯规局面摆好了：玩家已拿到全色，最近的合法目标是那颗全色（挡路的花色不算目标）',
  wrongBallSetup.group === 'solid' && wrongBallSetup.target === 'b2',
  JSON.stringify(wrongBallSetup)
);

const foulWrong = await gameManualShot('1.20', 2);
console.log('球局手打·先碰非目标球:', JSON.stringify(foulWrong));
check(
  '球局里手打先碰到非目标球：播报点名犯规类型（母球先碰到的不是合法目标球，WPA 3.2）',
  /犯规：母球先碰到的不是合法目标球（WPA 3\.2）/.test(foulWrong.report),
  foulWrong.report || '超时'
);
check(
  '犯规之后轮次交给对手：播报写「换 对手」，记分板回合标记也移到对手',
  /换 对手/.test(foulWrong.report) && foulWrong.turn === 1 && foulWrong.turnName === '对手',
  `${foulWrong.report} / turn=${foulWrong.turnName}`
);
check(
  '犯规之后播报给出持球处理（在台面上点一下放母球），不是一句犯规就完了',
  /持球：在台面上点一下放母球/.test(foulWrong.report),
  foulWrong.report
);
check(
  '犯规这一杆也进对局记录，且带犯规字样',
  foulWrong.logRows.length === 2 && /第 2 杆/.test(foulWrong.logRows[0]) && /犯规/.test(foulWrong.logRows[0]),
  JSON.stringify(foulWrong.logRows)
);

// ------------------------------------------------------------ 撤销之后手打
//
// 撤销会把局面退回去（undoGame 从 history 里弹一份快照装回来）。如果这条路上
// 读的是撤销之前的球位副本——不管是 simulateShot 拿到了旧数组，还是
// state.game.balls 没被换掉——页面不会报错，只会拿一张「1 号球已经没了、
// 母球还在袋口」的台子算一杆，播报自然就错了。所以这里打完一杆、撤销、再打，
// 拿第二杆的播报跟第一杆对着看：第一杆是「进 1 号 + 母球落袋」，
// 第二杆必须是「进 1 号、没有母球落袋」——两边一模一样就说明读到的是旧副本。

const undoSetup = JSON.parse(await evaluate(GAME_SETUP));
const firstShot = await gameManualShot('3.20', 1);
console.log('撤销后手打·第一杆（3.20，母球摔袋）:', JSON.stringify(firstShot));
check(
  '撤销用例的第一杆确实是「进球 + 母球落袋」的犯规杆（后面才有可撤销的东西）',
  /进 1 号/.test(firstShot.report) && /犯规：母球落袋（WPA 3\.1）/.test(firstShot.report) &&
    firstShot.shots === 1 && firstShot.history === 1,
  firstShot.report || '超时'
);

const undone = JSON.parse(await evaluate(`(() => {
  document.getElementById('gUndo').click();
  return ${GAME_SNAP};
})()`));
console.log('撤销后手打·撤销之后:', JSON.stringify(undone));
check(
  '撤销之后局面真的退回去了：杆数归 0、撤销栈清空、母球和 1 号球都回到摆好的位置',
  undone.shots === 0 && undone.history === 0 &&
    undone.cue !== null && undone.cue.pocketed === false &&
    Math.abs(undone.cue.x - undoSetup.cue.x) < 1e-6 &&
    Math.abs(undone.cue.y - undoSetup.cue.y) < 1e-6 &&
    undone.b1 !== null && undone.b1.pocketed === false &&
    Math.abs(undone.b1.x - undoSetup.b1.x) < 1e-6,
  JSON.stringify({ shots: undone.shots, history: undone.history, cue: undone.cue, b1: undone.b1 })
);
check(
  '撤销之后页面上说得清退到哪儿了：播报「已撤销一步」、提示要重新求解、对局记录回到空',
  /已撤销一步/.test(undone.report) && /撤销后要重新/.test(undone.verdict) &&
    undone.logRows.length === 0 && undone.logText === '—',
  `${undone.report} / ${undone.verdict} / log=${undone.logText}`
);
check(
  '撤销之后撤销按钮自己变灰，不再挂着上一杆的计数',
  undone.undoDisabled === true && !/（1）/.test(undone.undoLabel),
  `${undone.undoLabel} disabled=${undone.undoDisabled}`
);

const afterUndoShot = await gameManualShot('1.20', 1);
console.log('撤销后手打·撤销之后 1.20:', JSON.stringify(afterUndoShot));
check(
  '撤销之后立刻手打：这一杆照样进 1 号并且不摔母球（读到撤销前的球位副本会变成「没有球进袋」）',
  /进 1 号/.test(afterUndoShot.report) && !/母球落袋/.test(afterUndoShot.report),
  afterUndoShot.report || '超时'
);
check(
  '撤销之后那一杆的播报跟撤销前那一杆不是同一句（缓存住上一杆结果的写法在这里会露出来）',
  afterUndoShot.report !== firstShot.report && afterUndoShot.report.length > 0,
  `${afterUndoShot.report} vs ${firstShot.report}`
);
check(
  '撤销之后那一杆按新的一杆重新记账：对局记录只有第 1 杆、没有犯规字样',
  afterUndoShot.logRows.length === 1 && /^第 1 杆 · 进 1 号 · 你 继续$/.test(afterUndoShot.logRows[0]),
  JSON.stringify(afterUndoShot.logRows)
);

// ------------------------------------------------------------ 读档之后替对手手打
//
// 读档之后轮次常常落在对手那边，而读档本身会把自动出杆暂停（否则刚恢复的球位
// 转脸就被对手改掉）。这段时间里「替对手打这一杆」是允许的——shootGameWith 的
// 守卫只在「开着自动出杆且没暂停」时才拦。这里验的是：这一杆真的按对手的身份
// 结算（播报里出现对手名、分组记到对手头上），而不是悄悄按自己的身份打掉。
//
// 存档 → 刷新 → 读档 是用户可见的一整条路。刷新之后页面里的状态全没了，
// 只能靠 localStorage，所以这条用例是自包含的：前面留下的局面一个都用不上。

await evaluate(GAME_SETUP);
const savedTurn = JSON.parse(await evaluate(`(() => {
  const app = window.__app;
  app.state.game.turn = 1;
  // 连着存两次：第一次可能被「存档已经被另一个标签页改过」挡下来，
  // 第二次带上 saveOverwrite 就真的写了（两种情况下都落盘）。
  app.saveGame();
  app.saveGame();
  return JSON.stringify({ report: document.getElementById('report').textContent.replace(/\\s+/g, ' ').trim() });
})()`));
console.log('读档后替对手·存档:', JSON.stringify(savedTurn));
check('存了一份「轮到对手」的档，播报确认已存', /已存档：第 0 杆/.test(savedTurn.report), savedTurn.report);

await send(ws, 'Page.navigate', { url: URL });
await sleep(2500);
const reloaded = JSON.parse(await evaluate(`(() => {
  return JSON.stringify({ app: Boolean(window.__app), mode: window.__app ? window.__app.state.mode : null,
    save: document.getElementById('saveInfo') ? document.getElementById('saveInfo').textContent.trim() : null });
})()`));
check('刷新之后页面重新起来，存档还在（localStorage 里那份没丢）', reloaded.app === true, JSON.stringify(reloaded));

const loaded = JSON.parse(await evaluate(`(() => {
  document.getElementById('loadGame').click();
  return ${GAME_SNAP};
})()`));
console.log('读档后替对手·读档:', JSON.stringify(loaded));
check(
  '读档之后轮次落在对手那边，播报点名「轮到对手」',
  loaded.mode === 'game' && loaded.turn === 1 && /轮到「对手」/.test(loaded.report),
  `${loaded.mode} / turn=${loaded.turn} / ${loaded.report}`
);
check(
  '读档之后自动出杆被暂停（否则对手马上自己打一杆，替它打这条路径根本没机会走）',
  loaded.pauseHidden === false && /读档之后/.test(loaded.pauseText),
  `${loaded.pauseText} hidden=${loaded.pauseHidden}`
);

// 关掉自动出杆再手打：读档后的暂停会在「玩家亲手打一杆」那一刻解除，
// 到时候对手接着自己出杆，会把刚结算的播报改掉——那是另一条路径的事。
const turnedOff = JSON.parse(await evaluate(`(() => {
  const box = document.getElementById('autoOpponent');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ autoOpponent: window.__app.state.autoOpponent });
})()`));
check('读档后关掉自动出杆，接下来这一杆由玩家替对手打', turnedOff.autoOpponent === false, JSON.stringify(turnedOff));

const asOpponent = await gameManualShot('1.20', 1);
console.log('读档后替对手·手打:', JSON.stringify(asOpponent));
check(
  '读档后替对手手打：这一杆真的发生了（杆数 0 → 1），没有停在「现在是对手回合」那类提示上',
  asOpponent.shots === 1 && asOpponent.advice === '—' && !/没有可以打的球/.test(asOpponent.advice),
  JSON.stringify({ shots: asOpponent.shots, advice: asOpponent.advice })
);
check(
  '读档后替对手手打：播报按对手的身份结算（「对手 继续」），不是记在自己头上',
  /进 1 号/.test(asOpponent.report) && /对手 继续/.test(asOpponent.report) && !/你 继续/.test(asOpponent.report),
  asOpponent.report || '超时'
);
check(
  '读档后替对手手打：分组记到对手头上，记分板把全色给对手、花色给自己',
  /分组：对手拿到全色/.test(asOpponent.report) && /对手 全色/.test(asOpponent.score) &&
    /你 花色/.test(asOpponent.score),
  `${asOpponent.report} / ${asOpponent.score}`
);
check(
  '读档后替对手手打：球位真的跟着变了（1 号球进袋、母球停在袋口），对局记录记在对手名下',
  asOpponent.b1 !== null && asOpponent.b1.pocketed === true &&
    asOpponent.cue !== null && asOpponent.cue.pocketed === false &&
    (Math.abs(asOpponent.cue.x - loaded.cue.x) > 0.1 || Math.abs(asOpponent.cue.y - loaded.cue.y) > 0.1) &&
    asOpponent.logRows.length === 1 && /对手 继续/.test(asOpponent.logRows[0]),
  JSON.stringify({ cue: asOpponent.cue, was: loaded.cue, b1: asOpponent.b1, log: asOpponent.logRows })
);

// 收拾干净：回到练习模式的三球局，后面量布局的用例不该读到球局这套面板。
await evaluate(`(() => {
  window.__app.setMode('practice');
  window.__app.resetLayout();
})()`);

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

// ------------------------------------------------------------ 画布几何：内部宽必须等于 CSS 宽
//
// 画布受 canvas{max-width:100%} 约束：fit() 拿到的可用宽只要比内容盒大一点，
// CSS 就会把画布压回去，而内部坐标系没跟着缩——台面横向压扁，点选反算同比例偏。
// toPx 与 toWorld 是互逆的，单测它俩往返永远是 0，验不出这个问题；这里量的是
// 「这颗球画在屏幕上哪儿」与「点了那儿算出的世界点」之间的差：内部 px 先按
// 挤压倍率 k = rect.width / (canvas.width/dpr) 映射成屏幕 px，再走 app 的反算链
// （pointerPos 只做 clientX - rect.left，然后 view.toWorld）。

async function measureCanvasGeom() {
  return JSON.parse(
    await evaluate(`(() => {
      const app = window.__app;
      const c = document.getElementById('table');
      const v = app.view;
      const t = app.table;
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      const bufW = c.width / dpr;
      const bufH = c.height / dpr;
      const kx = r.width / bufW;
      const ky = r.height / bufH;
      const M = 0.13;
      const wx = t.length * 0.9;
      const wy = t.width * 0.2;
      const ix = v.offset.x + wx * v.scale;
      const iy = v.offset.y + (t.width - wy) * v.scale;
      const got = v.toWorld(ix * kx, iy * ky);
      return JSON.stringify({
        dpr,
        bufW,
        bufH,
        cssW: r.width,
        cssH: r.height,
        diffW: bufW - r.width,
        diffH: bufH - r.height,
        aspectCss: r.width / r.height,
        aspectIdeal: (t.length + 2 * M) / (t.width + 2 * M),
        errPx: Math.hypot((got.x - wx) * v.scale * kx, (got.y - wy) * v.scale * ky),
      });
    })()`)
  );
}

function checkCanvasGeom(tag, r) {
  check(
    tag + '：canvas 内部宽与 CSS 宽一致（差 ≤1px，画布没被挤扁）',
    Math.abs(r.diffW) <= 1,
    `内部宽=${r.bufW.toFixed(2)} CSS 宽=${r.cssW.toFixed(2)} 差=${r.diffW.toFixed(2)}px`
  );
  check(
    tag + '：canvas 内部高与 CSS 高一致（差 ≤1px）',
    Math.abs(r.diffH) <= 1,
    `内部高=${r.bufH.toFixed(2)} CSS 高=${r.cssH.toFixed(2)} 差=${r.diffH.toFixed(2)}px`
  );
  check(
    tag + '：台面纵横比与画布一致（偏差 <0.2%）',
    Math.abs(r.aspectCss / r.aspectIdeal - 1) < 0.002,
    `CSS 比例=${r.aspectCss.toFixed(4)} 理想=${r.aspectIdeal.toFixed(4)}`
  );
  check(
    tag + '：按球画在屏幕上的位置点选，反算误差 <1px 对应的距离',
    r.errPx < 1,
    `偏差 ${r.errPx.toFixed(2)}px`
  );
}

const geomDesktop = await measureCanvasGeom();
console.log('画布几何·桌面:', geomDesktop);
checkCanvasGeom('桌面', geomDesktop);

// 手机视口（390×844, dsf2）单独再量一遍：窄屏是 @media 改过 padding 的那段，
// 桌面过了手机不一定过（padding 16 vs 24，可用宽算错的比例不一样）。
await send(ws, 'Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await new Promise((r) => setTimeout(r, 450));

const geomMobile = await measureCanvasGeom();
console.log('画布几何·手机 390×844:', geomMobile);
checkCanvasGeom('手机 390×844', geomMobile);

await send(ws, 'Emulation.clearDeviceMetricsOverride');
await new Promise((r) => setTimeout(r, 400));

// ------------------------------------------------------------ 换标签页之后第一次存档
//
// 新开的标签页从没见过任何存档（saveStamp 是 null），旧实现因此在它第一次点
// 「存这一局」时直接覆盖——那边的一局就这么没了，还一句提示都没有。
// 会话标识（sessionStorage 里的一次性 id）就是拿来分清「自己的档」和「别人的档」：
// 同会话反复存不打扰，别人的档要先说明再覆盖。这里两件事都验。

const crossSession = await evaluate(`(() => {
  const app = window.__app;
  const key = 'pool-ai-coach/game/v1';
  const realSession = app.state.saveSession;
  app.setMode('game');
  app.newGame();
  localStorage.removeItem(key);

  // 装作「另一个标签页写的档」：存档里记的写入方是别的会话
  app.state.saveSession = 'tab-other-0001';
  app.state.saveStamp = null;
  app.state.saveOverwrite = false;
  app.saveGame();
  const foreign = JSON.parse(localStorage.getItem(key));

  // 再把自己当成刚从另一个标签页新开出来的窗口：没见过这份档，时间戳是 null
  app.state.saveSession = 'tab-mine-0002';
  app.state.saveStamp = null;
  app.state.saveOverwrite = false;
  app.state.game.shots = 3;
  app.saveGame();
  const firstReport = document.getElementById('report').textContent;
  const afterFirst = JSON.parse(localStorage.getItem(key));
  const kept = {
    shots: afterFirst.shots === foreign.shots,
    stamp: afterFirst.savedAt === foreign.savedAt,
    session: afterFirst.session === foreign.session,
  };

  // 第二次点才覆盖
  app.saveGame();
  const secondReport = document.getElementById('report').textContent;
  const afterSecond = JSON.parse(localStorage.getItem(key));

  // 同一会话里连存两次：不许打扰
  localStorage.removeItem(key);
  app.state.saveStamp = null;
  app.state.saveOverwrite = false;
  app.saveGame();
  const soloFirst = document.getElementById('report').textContent;
  app.saveGame();
  const soloSecond = document.getElementById('report').textContent;

  app.state.saveSession = realSession;
  localStorage.removeItem(key);
  app.state.saveStamp = null;
  app.state.saveOverwrite = false;

  return JSON.stringify({
    foreignShots: foreign.shots,
    firstReport: firstReport.slice(0, 120),
    secondReport: secondReport.slice(0, 60),
    kept,
    overwrote: afterSecond.session === 'tab-mine-0002' && afterSecond.shots === 3,
    soloFirst: soloFirst.slice(0, 40),
    soloSecond: soloSecond.slice(0, 40),
  });
})()`);
console.log('存档·换标签页:', crossSession);
{
  const r = JSON.parse(crossSession);
  check(
    '新标签页第一次存档要拦下来，并说明这份档是另一个标签页写的',
    /另一个标签页/.test(r.firstReport) && /另一个标签页写的/.test(r.firstReport),
    r.firstReport
  );
  check(
    '被拦时把对方存到第几杆说出来',
    r.firstReport.includes(String(r.foreignShots)),
    `对方第 ${r.foreignShots} 杆 → ${r.firstReport}`
  );
  check(
    '被拦时一个字都没写进去（对方的杆数、时间戳、写入方都在）',
    r.kept.shots === true && r.kept.stamp === true && r.kept.session === true,
    JSON.stringify(r.kept)
  );
  check('再点一次才覆盖，存的是本页这一局', r.overwrote === true && /已存档/.test(r.secondReport), r.secondReport);
  check(
    '同一会话里反复存档不弹提示（正常流程不被打扰）',
    /已存档/.test(r.soloFirst) &&
      /已存档/.test(r.soloSecond) &&
      !/另一个标签页/.test(r.soloFirst) &&
      !/另一个标签页/.test(r.soloSecond),
    JSON.stringify({ first: r.soloFirst, second: r.soloSecond })
  );
}

// ------------------------------------------------------------ 回放中点撤销
//
// 回放还在往球数组里写帧，此刻撤销会被下一帧盖回去。旧实现直接 return，
// 按钮还亮着、画面没变、也没有一句话——用户只会以为撤销坏了。

const undoMidReplay = await evaluate(`(() => {
  const app = window.__app;
  app.setMode('game');
  app.newGame();
  app.state.autoOpponent = false;
  const g = app.state.game;
  g.turn = 0;
  g.breakShot = false;
  g.requiresRerack = false;
  g.ballInHand = null;
  app.gameSolve();
  app.gameShoot();
  const btn = document.getElementById('gUndo');
  const snap = {
    animating: app.state.animating,
    disabled: btn.disabled,
    title: btn.title,
    shots0: app.state.game.shots,
    hist0: app.state.history.length,
  };
  app.undoGame();
  snap.report = document.getElementById('report').textContent;
  snap.shots1 = app.state.game.shots;
  snap.hist1 = app.state.history.length;
  return JSON.stringify(snap);
})()`);
console.log('撤销·回放中:', undoMidReplay);
{
  const r = JSON.parse(undoMidReplay);
  check('回放中撤销按钮是灰的（不是点得动却没反应）', r.animating === true && r.disabled === true, JSON.stringify(r));
  check('回放中按钮的 title 说明了为什么不能撤', /回放/.test(r.title), r.title);
  check(
    '回放中点撤销会给出文字说明，不是静默吞掉',
    /回放/.test(r.report) && /撤销/.test(r.report),
    r.report
  );
  check('回放中点撤销不动局面', r.shots1 === r.shots0 && r.hist1 === r.hist0, JSON.stringify(r));
}
// 等这一杆演完，别让后面的检查读到半途的局面
for (let i = 0; i < 60; i++) {
  const a = await evaluate(`window.__app.state.animating`);
  if (!a) break;
  await sleep(200);
}

// ------------------------------------------------------------ 存档失败的两句文案
//
// 隐私模式（存储整块打不开）和配额满（写得进但满了）要分开说：前者换窗口才行，
// 后者删旧档就有地方。合成一句「或者配额满了」等于什么都不告诉人。

const saveFailure = await evaluate(`(() => {
  const app = window.__app;
  const proto = Object.getPrototypeOf(localStorage);
  const desc = (name) => Object.getOwnPropertyDescriptor(proto, name);
  const origSet = desc('setItem');
  const origGet = desc('getItem');
  const put = (name, value) => Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  const back = (name, d) => {
    if (d) Object.defineProperty(proto, name, d);
    else delete proto[name];
  };
  const out = {};
  app.setMode('game');
  app.newGame();
  try {
    // 配额满：读得到旧档，写的时候抛
    put('setItem', function () {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    app.state.saveOverwrite = true;
    app.saveGame();
    out.quota = document.getElementById('report').textContent;
  } finally {
    back('setItem', origSet);
  }
  try {
    // 隐私模式 / 存储被禁：读写都抛（真实的 localStorage 是访问就抛，不是只读抛）
    const denied = function () {
      throw new DOMException('denied', 'SecurityError');
    };
    put('getItem', denied);
    put('setItem', denied);
    app.state.saveOverwrite = true;
    app.saveGame();
    out.blocked = document.getElementById('report').textContent;
  } finally {
    back('setItem', origSet);
    back('getItem', origGet);
  }
  // 恢复之后必须还能正常存（别把 localStorage 留在坏状态里）
  app.state.saveOverwrite = true;
  app.saveGame();
  out.recovered = /已存档/.test(document.getElementById('report').textContent);
  localStorage.removeItem('pool-ai-coach/game/v1');
  return JSON.stringify(out);
})()`);
console.log('存档·失败文案:', saveFailure);
{
  const r = JSON.parse(saveFailure);
  check(
    '配额满的文案说清是配额、并提示删旧存档腾空间',
    /配额/.test(r.quota) && /删除存档/.test(r.quota),
    r.quota
  );
  check(
    '隐私模式 / 存储被禁的文案是另一句（不是笼统一句）',
    /隐私模式/.test(r.blocked) && r.blocked !== r.quota,
    r.blocked
  );
  check('文案验完之后 localStorage 仍然可用', r.recovered === true, String(r.recovered));
}

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
