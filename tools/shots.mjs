/**
 * 自己レビュー用のスクリーンショット（外部依存ゼロ。Chrome を CDP で直接操作する）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130        # 別ターミナルで起動しておく
 *   node tools/shots.mjs [出力先ディレクトリ] [URL]
 *
 * PC（1280px）とスマホ（390px）を、ライト・ダークの両方で撮る。
 * ページを上から1画面ずつ撮って WebP で書き出す。ファイル名: {pc|mobile}-{light|dark}/NN.webp
 * ダークは Emulation.setEmulatedMedia で prefers-color-scheme を切り替える
 * （ページの保存値は使わない。毎回新しいプロファイルで起動するため）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || join(tmpdir(), 'pf-shots');
const BASE = process.argv[3] || 'http://127.0.0.1:8130/';
const ONLY = process.env.SHOTS_ONLY; // 例: "mobile-dark"
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'pc', width: 1280, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true }
];
const THEMES = ['light', 'dark'];

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

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const tag = `${vp.name}-${theme}`;
      if (ONLY && ONLY !== tag) continue;
      const dir = join(OUT, tag);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
      });
      await send('Page.navigate', { url: BASE });
      await sleep(2200);
      await evaluate('document.fonts.ready.then(() => 1)');
      await sleep(400);

      const pageH = await evaluate('document.documentElement.scrollHeight');
      const overflow = await evaluate('({sw: document.documentElement.scrollWidth, iw: window.innerWidth})');
      const shown = await evaluate("document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')");
      const screens = Math.ceil(pageH / vp.height);
      for (let s = 0; s < screens; s++) {
        await evaluate(`scrollTo(0, ${s * vp.height}); 1`);
        await sleep(450); // 遅延読み込みの画像と、導線の色の変化を待つ
        const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 80 });
        writeFileSync(join(dir, `${String(s + 1).padStart(2, '0')}.webp`), Buffer.from(shot.result.data, 'base64'));
      }
      console.log(`${tag.padEnd(13)} 全高 ${String(pageH).padStart(5)}px / ${screens}枚 / 表示テーマ ${shown} / ` +
        (overflow.sw > overflow.iw ? `横スクロールあり(${overflow.sw}>${overflow.iw})` : '横スクロールなし'));
    }
  }
  ws.close();
  console.log('出力先: ' + OUT);
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
