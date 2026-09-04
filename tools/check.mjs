/**
 * portfolio-lp-spec.md「検証項目」の機械確認（外部依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130        # 別ターミナルで起動しておく
 *   node tools/check.mjs [URL]
 *
 * 横スクロール / 結線図の縦積み / prefers-reduced-motion / キーボード到達性 /
 * コントラスト比を、実ブラウザ上で確認して結果を出す。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8130/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}${detail ? '  — ' + detail : ''}`);
};

/** WCAG 2.x の相対輝度とコントラスト比 */
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const profile = mkdtempSync(join(tmpdir(), 'pf-check-'));
const chrome = spawn(CHROME, [
  '--headless', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'
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
  const load = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 768
    });
    await send('Page.navigate', { url: BASE });
    await sleep(1800);
    await evaluate('document.fonts.ready.then(() => 1)');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');

  // --- 1. 横スクロール -----------------------------------------------------
  for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]]) {
    await load(w, h);
    const m = await evaluate('({sw:document.documentElement.scrollWidth, iw:window.innerWidth})');
    record(m.sw <= m.iw, `${w}px幅で横スクロールが発生しない`, `scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  }

  // --- 2. 結線図が375pxで縦積みになる -------------------------------------
  await load(375, 812);
  const wire = await evaluate(`(() => {
    const s = document.querySelector('.wire__steps');
    const cs = getComputedStyle(s);
    const tops = [...s.children].map(el => Math.round(el.getBoundingClientRect().top));
    return { cols: cs.gridTemplateColumns, rows: new Set(tops).size, count: s.children.length,
             maxRight: Math.max(...[...s.children].map(el => Math.round(el.getBoundingClientRect().right))) };
  })()`);
  record(
    wire.cols.split(' ').length === 1 && wire.rows === wire.count && wire.maxRight <= 375,
    '結線図が375px幅で破綻せず、縦積みに切り替わる',
    `列数 ${wire.cols.split(' ').length} / ${wire.count}工程が${wire.rows}段 / 右端 ${wire.maxRight}px`
  );

  // --- 2b. ヒーロー見出しが文節の切れ目でしか折り返さない -------------------
  const heroExpr = `(() => {
    const h = document.querySelector('.hero h1');
    const units = [...h.querySelectorAll('.hero__u')];
    const lines = [];
    for (const u of units) {
      const r = u.getBoundingClientRect();
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - r.top) < 2) last.text += u.textContent;
      else lines.push({ top: r.top, text: u.textContent });
    }
    return { split: units.some(u => u.getClientRects().length > 1), lines: lines.map(l => l.text) };
  })()`;
  const hero = {};
  for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]]) {
    await load(w, h);
    hero[w] = await evaluate(heroExpr);
  }
  record(
    !Object.values(hero).some((r) => r.split) &&
    hero[375].lines.length === 3 && hero[768].lines.length === 2 && hero[1440].lines.length === 2,
    'ヒーロー見出しが文節の途中で改行しない（512px以上は2行、それ未満は3行）',
    `375px: ${hero[375].lines.join(' / ')} ／ 1440px: ${hero[1440].lines.join(' / ')}`
  );

  // --- 2c. 767px以下でも導線が出ていて、左端が揃っている ---------------------
  await load(375, 812);
  const rail = await evaluate(`(() => {
    const spine = getComputedStyle(document.querySelector('.rail'), '::before');
    const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
    return {
      shown: spine.display !== 'none',
      spineX: parseFloat(spine.left),
      h2: x('#skills > h2'), h3: x('.skill h3'), body: x('.skill p'), lead: x('.lead')
    };
  })()`);
  const edges = [rail.h2, rail.h3, rail.body, rail.lead];
  record(
    rail.shown && rail.spineX >= 8 && rail.spineX <= 12 && new Set(edges).size === 1,
    '767px以下で縦導線が表示され、h2・h3・本文の左端が揃っている',
    `縦線 x=${rail.spineX}px（帯8〜12px） / 左端 h2:${rail.h2} h3:${rail.h3} 本文:${rail.body} リード:${rail.lead}`
  );

  // --- 3. prefers-reduced-motion -------------------------------------------
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await load(1440, 900);
  const motion = await evaluate(`(() => {
    const d = getComputedStyle(document.querySelector('.wire__draw'));
    const t = getComputedStyle(document.querySelector('.wire__term'));
    return { drawAnim: d.animationName, drawTransform: d.transform,
             termAnim: t.animationName, termOpacity: t.opacity,
             scroll: getComputedStyle(document.documentElement).scrollBehavior };
  })()`);
  record(
    motion.drawAnim === 'none' && motion.termAnim === 'none' &&
    motion.termOpacity === '1' && motion.drawTransform === 'none' && motion.scroll === 'auto',
    'prefers-reduced-motion でアニメーションが無効化される',
    `バイパス線 animation:${motion.drawAnim} transform:${motion.drawTransform} / 端子 animation:${motion.termAnim} opacity:${motion.termOpacity} / scroll-behavior:${motion.scroll}`
  );
  await send('Emulation.setEmulatedMedia', { features: [] });

  // 通常時はアニメーションが定義されていること（1回だけ・繰り返さない）
  await load(1440, 900);
  const anim = await evaluate(`(() => {
    const d = getComputedStyle(document.querySelector('.wire__draw'));
    const t = getComputedStyle(document.querySelector('.wire__term'));
    const scrollLinked = [...document.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).animationName !== 'none').length;
    return { name: d.animationName, count: d.animationIterationCount, dur: d.animationDuration,
             termDelay: t.animationDelay, animated: scrollLinked };
  })()`);
  record(
    anim.name === 'wire-draw' && anim.count === '1' && anim.dur === '0.9s' && anim.termDelay === '0.9s' && anim.animated === 2,
    'モーションはヒーローの結線図の1回だけ',
    `${anim.name} ${anim.dur} ×${anim.count} / 端子 delay ${anim.termDelay} / アニメーションを持つ要素 ${anim.animated}個`
  );

  // --- 4. キーボード到達性 --------------------------------------------------
  const links = await evaluate(`[...document.querySelectorAll('a[href]')].map(a => a.textContent.trim().slice(0,24))`);
  await evaluate('document.body.focus(); 1');
  const reached = [];
  for (let i = 0; i < links.length + 4; i++) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
      });
    }
    const el = await evaluate(`(() => {
      const a = document.activeElement;
      if (!a || a.tagName !== 'A') return null;
      const o = getComputedStyle(a, ':focus-visible');
      return { text: a.textContent.trim().slice(0,24), href: a.getAttribute('href') };
    })()`);
    if (el && !reached.some((r) => r.href === el.href)) reached.push(el);
  }
  record(
    reached.length === links.length,
    '全リンクがキーボードで到達・操作できる',
    `${reached.length} / ${links.length} 本に Tab で到達`
  );

  // --- 5. コントラスト比 ----------------------------------------------------
  const tokens = await evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const k of ['--ink','--paper','--paper-deep','--line','--terminal','--mute']) out[k] = cs.getPropertyValue(k).trim();
    return out;
  })()`);
  const r = ratio(tokens['--line'], tokens['--paper']);
  record(r >= 4.5, '--line と --paper のコントラスト比が4.5:1以上',
    `${tokens['--line']} on ${tokens['--paper']} = ${r.toFixed(2)}:1`);

  // トークンの組み合わせではなく、実際に描画されている文字と背景を総当たりで見る
  const rendered = await evaluate(`(() => {
    const toHex = (c) => {
      const m = c.match(/[\\d.]+/g).map(Number);
      return '#' + m.slice(0,3).map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const b = getComputedStyle(n).backgroundColor;
        if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return toHex(b);
      }
      return '#ffffff';
    };
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || !el.getClientRects().length) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || '',
        text: el.textContent.trim().slice(0, 18),
        fg: toHex(cs.color), bg: bgOf(el),
        px: parseFloat(cs.fontSize), weight: cs.fontWeight
      });
    }
    return out;
  })()`);
  const fails = rendered.filter((n) => {
    // WCAG AA: 24px以上、または18.66px以上の太字は 3:1、それ以外は 4.5:1
    const large = n.px >= 24 || (n.px >= 18.66 && Number(n.weight) >= 700);
    return ratio(n.fg, n.bg) < (large ? 3 : 4.5);
  });
  record(fails.length === 0,
    '描画されている全テキストが WCAG AA のコントラストを満たす',
    fails.length
      ? fails.slice(0, 4).map((n) => `${n.tag}.${n.cls}「${n.text}」${n.fg} on ${n.bg} = ${ratio(n.fg, n.bg).toFixed(2)}:1`).join(' / ')
      : `${rendered.length}箇所を検査してすべて基準以上（最小 ${Math.min(...rendered.map(n => ratio(n.fg, n.bg))).toFixed(2)}:1）`);

  // --- 6. 出してはいけない情報 ----------------------------------------------
  const text = await evaluate('document.body.innerText');
  const banned = ['NTT', '3万', '三万', '数万', '教育機関', '万台', '依頼番号'];
  const hits = banned.filter((w) => text.includes(w));
  record(hits.length === 0,
    '勤務先・実クライアントが特定されうる記述が本文に無い',
    hits.length ? '検出: ' + hits.join(', ') : `${banned.length}語すべて不検出`);

  // --- 7. 見出し階層 --------------------------------------------------------
  const heads = await evaluate(`[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1])`);
  let jump = null;
  for (let i = 1; i < heads.length; i++) if (heads[i] - heads[i - 1] > 1) jump = `${heads[i - 1]} -> ${heads[i]}`;
  record(heads[0] === 1 && heads.filter((h) => h === 1).length === 1 && !jump,
    '見出しが h1 -> h2 -> h3 の順序を崩さない',
    jump ? '飛び: h' + jump : `h1×${heads.filter(h=>h===1).length} / 全${heads.length}個、飛びなし`);

  ws.close();
  const ng = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - ng} / ${results.length} 項目が OK` + (ng ? `（NG ${ng} 件）` : ''));
  process.exitCode = ng ? 1 : 0;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
