// 用 file:// 直接双击打开时的兜底提示。
//
// 页面主体是 ES module，浏览器在 file:// 下会以 CORS 为由拒绝加载模块，结果是
// 纯白页、控制台一行红字、页面上什么提示都没有——用的人只会以为程序坏了。
//
// 这段刻意写成普通脚本（不是 module）：普通脚本在 file:// 下仍然会执行，所以它能
// 在模块被拒之后再补一句人话。它必须排在所有 module 脚本之前，且不能 import 任何
// 东西，否则自己也会被 CORS 拒掉。

(function () {
  if (location.protocol !== 'file:') return;

  function show() {
    if (document.getElementById('file-protocol-notice')) return;

    document.title = '需要先起本地服务 · 台球 AI 教练';

    const wrap = document.createElement('div');
    wrap.id = 'file-protocol-notice';
    wrap.setAttribute('role', 'alert');
    wrap.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:#141c26',
      'color:#e2e8f0',
      'font:16px/1.75 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'max-width:560px',
      'padding:28px 30px',
      'border:1px solid rgba(255,255,255,0.14)',
      'border-radius:14px',
      'background:rgba(28,41,56,0.92)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '这个页面得通过本地服务打开';
    title.style.cssText = 'font-size:19px;font-weight:600;margin-bottom:14px;color:#fff';

    const why = document.createElement('p');
    why.textContent =
      '浏览器在 file:// 下会以 CORS 为由拒绝加载 ES module，所以直接双击 index.html 只会是白屏。';
    why.style.cssText = 'margin:0 0 16px';

    const how = document.createElement('p');
    how.textContent = '在仓库根目录运行：';
    how.style.cssText = 'margin:0 0 8px';

    const code = document.createElement('code');
    code.textContent = 'node tools/start.mjs';
    code.style.cssText = [
      'display:block',
      'padding:10px 14px',
      'margin-bottom:16px',
      'border-radius:8px',
      'background:rgba(0,0,0,0.35)',
      'color:#7dd3fc',
      'font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace',
      'user-select:all',
    ].join(';');

    const rest = document.createElement('p');
    rest.textContent =
      '它会起服务并打开 http://127.0.0.1:4173/demo/ 。只想起服务就运行 node tools/serve.mjs ，再手动访问同一个地址。需要 Node 22 及以上，不用安装任何依赖。';
    rest.style.cssText = 'margin:0;color:#94a3b8;font-size:14px';

    card.appendChild(title);
    card.appendChild(why);
    card.appendChild(how);
    card.appendChild(code);
    card.appendChild(rest);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();