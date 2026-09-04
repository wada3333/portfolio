/**
 * 自己レビュー用のスクリーンショット（外部依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130        # 別ターミナルで起動しておく
 *   node tools/shots.mjs [出力先ディレクトリ] [URL]
 *
 * 375 / 768 / 1440px の3幅で、ページを上から1画面ずつ撮って WebP で書き出す。
 * CDP の Page.captureScreenshot に format:'webp' を渡すので、受信が軽い。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || join(tmpdir(), 'pf-shots');
const BASE = process.argv[3] || 'http://127.0.0.1:8130/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [幅, 画面高さ] */
const WIDTHS = [[375, 812], [768, 1024], [1440, 900]];

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'pf-shots-'));
const chrome = spawn(CHROME, [
  '--headless', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* 起動待ち */ }
    await sleep(250);
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
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
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  for (const [width, height] of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 768
    });
    await send('Page.navigate', { url: BASE });
    await sleep(2200);
    await evaluate('document.fonts.ready.then(() => 1)');
    await sleep(400);

    const pageH = await evaluate('document.documentElement.scrollHeight');
    const overflow = await evaluate(
      '({sw: document.documentElement.scrollWidth, iw: window.innerWidth})'
    );
    console.log(`${width}px: 全高 ${pageH}px / scrollWidth ${overflow.sw} vs innerWidth ${overflow.iw}` +
      (overflow.sw > overflow.iw ? '  ← 横スクロールあり' : '  横スクロールなし'));

    const screens = Math.ceil(pageH / height);
    for (let s = 0; s < screens; s++) {
      const y = s * height;
      await evaluate(`scrollTo(0, ${y}); 1`);
      await sleep(250);
      const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82 });
      const name = `w${width}-${String(s + 1).padStart(2, '0')}.webp`;
      writeFileSync(join(OUT, name), Buffer.from(shot.result.data, 'base64'));
    }
    console.log(`  -> ${screens}枚`);
  }

  ws.close();
  console.log('出力先: ' + OUT);
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
