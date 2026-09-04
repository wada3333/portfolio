/**
 * Google Fonts の text= サブセットURLを、ページの実際の文字から組み立てる
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130        # 別ターミナルで起動しておく
 *   node tools/font-url.mjs [URL]
 *
 * Zen Kaku Gothic New を素で読むと、和文の unicode-range 分割によって
 * woff2 が60本（約560KB）落ちてきて、モバイルの Lighthouse Performance が
 * 66 まで落ちる。ページ内で実際に使う文字だけを text= で要求すれば1本で済む。
 *
 * コピーを変えたらこのスクリプトを流し直し、index.html の <link> を差し替えること。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8130/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'pf-font-'));
const chrome = spawn(CHROME, [
  '--headless', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank'
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* 起動待ち */ }
    await sleep(250);
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  await sleep(2000);

  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      let s = document.body.innerText;
      // ::before / ::after の生成内容（進め方の連番など）も拾う
      for (const el of document.querySelectorAll('*')) {
        for (const p of ['::before', '::after']) {
          const c = getComputedStyle(el, p).content;
          if (c && c !== 'none' && c !== 'normal') s += c.replace(/^"|"$/g, '');
        }
      }
      return s;
    })()`,
    returnByValue: true
  });
  ws.close();

  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  const chars = [...new Set((res.result.result.value + ascii).replace(/[\s\u200b]/g, ''))].sort().join('');
  const family = 'family=Inter+Tight:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;700';
  const url = `https://fonts.googleapis.com/css2?${family}&display=swap&text=${encodeURIComponent(chars)}`;

  console.log(`固有文字 ${chars.length} 字 / URL ${url.length} バイト\n`);
  console.log(url);
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
