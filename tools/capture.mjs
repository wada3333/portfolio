/**
 * 公開デモのスクリーンショット撮影と OG 画像の生成（外部依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/capture.mjs [demos|og|all]
 *
 * 撮影はヘッドレス Chrome の --screenshot に任せ、WebP 変換は同じ Chrome の
 * canvas.toBlob('image/webp') で行う。cwebp / sharp / puppeteer は不要。
 *   - デモ2枚: 1440x900 のファーストビュー -> assets/images/*.webp
 *   - OG画像 : 1200x630 -> assets/og.png（OGP は WebP の対応が不安定なので PNG）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [出力名, URL, 幅, 高さ, WebP品質] */
const DEMOS = [
  ['demo-crosstech.webp', 'https://wada3333.github.io/crosstech-lp/', 1440, 900, 0.82],
  ['demo-studio-core.webp', 'https://wada3333.github.io/studio-core-lp/', 1440, 900, 0.82]
];

const work = mkdtempSync(join(tmpdir(), 'pf-cap-'));
const mode = process.argv[2] || 'all';

/** ヘッドレス Chrome の --screenshot で1枚撮る（CDP を介さないので巨大な受信が起きない） */
function shoot(url, out, width, height) {
  const profile = mkdtempSync(join(tmpdir(), 'pf-shot-'));
  const res = spawnSync(CHROME, [
    '--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--force-color-profile=srgb',
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    url
  ], { stdio: 'ignore', timeout: 120000 });
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
  if (res.error) throw res.error;
  const size = statSync(out).size;
  console.log(`  撮影 ${url} -> ${(size / 1024).toFixed(0)}KB`);
}

/** CDP セッションを開く（encode-images.mjs と同じ手順） */
async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'pf-enc-'));
  const proc = spawn(CHROME, [
    '--headless', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', 'about:blank'
  ], { stdio: 'ignore' });

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

  await send('Runtime.enable');
  await sleep(400);
  return { send, close: () => { ws.close(); proc.kill(); } };
}

/** PNG を WebP に変換する。data: URI 経由なので canvas は汚染されない */
async function toWebp(send, pngPath, quality) {
  const dataUri = 'data:image/png;base64,' + readFileSync(pngPath).toString('base64');
  const expression = `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUri)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', ${quality}));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return JSON.stringify({ size: [img.naturalWidth, img.naturalHeight], data: btoa(bin) });
  })()`;
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return JSON.parse(res.result.result.value);
}

/**
 * OG画像（1200x630）の下絵。
 * 下地は assets/og-bg.png（1728x910）。縦横比 1.899 は 1200x630 の 1.905 と
 * ほぼ同じなので、トリミングではなく縮小で収める（object-fit:cover で縦2pxだけ切れる）。
 *
 * 文字の位置は下地のピクセルを走査して決めた。図の外接矩形は 1200x630 換算で
 * x 328-1151 / y 113-362。空いているのは下側 y 362-630（全幅）と左側 x 0-328
 * なので、下帯の左寄せに置く（文字ブロックの上端は y=421 で、図の下端から59px空く）。
 *
 * 書体はサイトと同じ woff2 をそのまま data URI で埋める。生成時に Google Fonts へ
 * 出ないので、いつ流し直しても同じ結果になる。
 */
function ogHtml(bg, fonts) {
  const face = (family, weight, file) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
    `src:url(${fonts[file]}) format('woff2')}`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<style>
${face('Inter Tight', 500, 'inter-tight-500.woff2')}
${face('Inter Tight', 700, 'inter-tight-700.woff2')}
${face('Zen Kaku Gothic New', 400, 'zen-kaku-gothic-new-400.woff2')}
${face('Zen Kaku Gothic New', 700, 'zen-kaku-gothic-new-700.woff2')}
:root{--ink:#101826;--paper:#EDF0F2;--line:#1F5FBF;--terminal:#E8B10D}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:var(--paper);color:var(--ink);position:relative;overflow:hidden;
  font-family:"Inter Tight","Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;
  font-variant-numeric:tabular-nums}
.bg{position:absolute;inset:0;width:1200px;height:630px;object-fit:cover;object-position:center}
.txt{position:absolute;left:72px;bottom:74px}
.name{font-size:64px;font-weight:700;letter-spacing:.02em;line-height:1.2}
.role{font-size:30px;font-weight:400;line-height:1.6;margin-top:10px;font-feature-settings:"palt" 1}
</style></head><body>
<img class="bg" src="${bg}" alt="">
<div class="txt">
  <p class="name">sawada</p>
  <p class="role">業務自動化 / Google Workspace / Web制作</p>
</div>
</body></html>`;
}

try {
  const pngs = [];

  if (mode === 'all' || mode === 'demos') {
    console.log('公開デモのファーストビューを撮影します（1440x900）');
    for (const [out, url, w, h, q] of DEMOS) {
      const png = join(work, out.replace('.webp', '.png'));
      shoot(url, png, w, h);
      pngs.push([out, png, q]);
    }
  }

  if (mode === 'all' || mode === 'og') {
    console.log('OG画像を生成します（1200x630）');
    // 下地と書体を data URI で埋め込む。相対パスは file:// の一時HTMLから引けないため
    const bg = 'data:image/png;base64,' +
      readFileSync(join(ROOT, 'assets', 'og-bg.png')).toString('base64');
    const fonts = {};
    for (const f of ['inter-tight-500.woff2', 'inter-tight-700.woff2',
      'zen-kaku-gothic-new-400.woff2', 'zen-kaku-gothic-new-700.woff2']) {
      fonts[f] = 'data:font/woff2;base64,' +
        readFileSync(join(ROOT, 'assets', 'fonts', f)).toString('base64');
    }
    const html = join(work, 'og.html');
    writeFileSync(html, ogHtml(bg, fonts), 'utf8');
    const out = join(ROOT, 'assets', 'og.png');
    shoot('file:///' + html.replace(/\\/g, '/'), out, 1200, 630);
    console.log(`  assets/og.png  1200x630  ${(statSync(out).size / 1024).toFixed(0)}KB`);
  }

  if (pngs.length) {
    const chrome = await openChrome();
    try {
      for (const [out, png, q] of pngs) {
        const r = await toWebp(chrome.send, png, q);
        const buffer = Buffer.from(r.data, 'base64');
        writeFileSync(join(ROOT, 'assets', 'images', out), buffer);
        console.log(`  assets/images/${out}  ${r.size.join('x')}  ${(buffer.length / 1024).toFixed(0)}KB`);
      }
    } finally {
      chrome.close();
      await sleep(400);
    }
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
