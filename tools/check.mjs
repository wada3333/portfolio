/**
 * portfolio-lp-spec.md（v2）の検証項目を、実ブラウザで機械的に確かめる（外部依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130        # 別ターミナルで起動しておく
 *   node tools/check.mjs [URL]
 *
 * Chrome を DevTools Protocol で直接操作する。ライト・ダーク、JS 有効・無効、
 * reduced-motion、?from=lc / cw を切り替えながら、§6.5 の項目を順に見る。
 * 本業に関わる語の一覧は tools/banned-words.local.txt（公開しない）から読む。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8130/';
const ORIGIN = new URL(BASE).origin;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}${detail ? '  — ' + detail : ''}`);
};

/** WCAG 2.x のコントラスト比 */
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

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
    if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
    return res.result.result.value;
  };

  /** 画面の状態を整えて開く。毎回、保存値（localStorage / sessionStorage）を消してから */
  const load = async (width, height, o = {}) => {
    const { theme = 'light', reduce = false, js = true, query = '' } = o;
    await send('Emulation.setScriptExecutionDisabled', { value: !js });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }
      ]
    });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
    await send('Page.navigate', { url: BASE + query });
    await sleep(1900);
    if (js) await evaluate('document.fonts.ready.then(() => 1)');
    await sleep(250);
  };

  /** 見えている要素か（display:none や hidden を除く） */
  const VIS = `const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('CSS.enable');

  // =========================================================================
  // 1. 横スクロール
  // =========================================================================
  for (const [w, h] of [[320, 700], [375, 812], [390, 844], [768, 1024], [1280, 900], [1440, 900]]) {
    await load(w, h);
    const m = await evaluate('({sw: document.documentElement.scrollWidth, iw: window.innerWidth})');
    record(m.sw <= m.iw, `${w}px幅で横スクロールが発生しない`, `scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  }
  await load(390, 844, { theme: 'dark' });
  {
    const m = await evaluate('({sw: document.documentElement.scrollWidth, iw: window.innerWidth})');
    record(m.sw <= m.iw, '390px幅（ダーク）で横スクロールが発生しない', `scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  }

  // =========================================================================
  // 2. ヒーローの見出しの折り返し（文節の途中で割れない。512px以上は2行、未満は3行）
  // =========================================================================
  const heroExpr = `(() => {
    const units = [...document.querySelectorAll('.hero h1 .hero__u')];
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
  for (const [w, h] of [[375, 812], [512, 900], [768, 1024], [1440, 900]]) { await load(w, h); hero[w] = await evaluate(heroExpr); }
  record(
    !Object.values(hero).some((r) => r.split) && hero[375].lines.length === 3 && hero[512].lines.length === 2 &&
    hero[768].lines.length === 2 && hero[1440].lines.length === 2,
    'ヒーローの見出しが文節の途中で改行しない（512px以上は2行、それ未満は3行）',
    `375px: ${hero[375].lines.join(' / ')} ／ 1440px: ${hero[1440].lines.join(' / ')}`
  );

  // =========================================================================
  // 3. 767px以下: 縦導線が出ていて、見出し・本文の左端が揃っている
  // =========================================================================
  await load(390, 844);
  const rail = await evaluate(`(() => {
    const spine = getComputedStyle(document.querySelector('.rail'), '::before');
    const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
    return {
      shown: spine.display !== 'none', spineX: parseFloat(spine.left),
      h2: x('#works > h2'), lead: x('.lead'), sec: x('#works > .sec-lead'), h3: x('.pillar h3'), step: x('.step h3') - 48
    };
  })()`);
  const edges = [rail.h2, rail.lead, rail.sec, rail.h3];
  record(rail.shown && rail.spineX >= 8 && rail.spineX <= 12 && new Set(edges).size === 1,
    '767px以下で縦導線が表示され、h2・h3・本文の左端が揃っている',
    `縦線 x=${rail.spineX}px / 左端 h2:${rail.h2} リード:${rail.lead} 実績の導入:${rail.sec} h3:${rail.h3}`);

  // =========================================================================
  // 4. ヒーローの結線図（業務を選ぶ）
  // =========================================================================
  for (const [label, w, h] of [['スマホ(390px)', 390, 844], ['PC(1280px)', 1280, 900]]) {
    await load(w, h);
    const res = [];
    for (const job of ['inv', 'inq', 'list']) {
      await evaluate(`document.getElementById('job-${job}').click(); 1`);
      await sleep(1200);
      const st = JSON.parse(await evaluate(`(() => {
        ${VIS}
        const panes = [...document.querySelectorAll('.wire-pane')];
        const shown = panes.filter(vis).map(p => p.dataset.job);
        const pane = panes.find(p => p.dataset.job === '${job}');
        const boxes = pane ? pane.querySelectorAll('.wire-before li').length : 0;
        const steps = pane ? pane.querySelectorAll('.wire-after li').length : 0;
        const term = pane ? getComputedStyle(pane.querySelector('.wire-after'), '::after') : null;
        const right = Math.max(...[...(pane ? pane.querySelectorAll('li') : [])].map(el => Math.round(el.getBoundingClientRect().right)));
        return JSON.stringify({ shown, boxes, steps, termOpacity: term ? term.opacity : null, right, iw: innerWidth });
      })()`));
      res.push({ job, ...st });
    }
    const ok = res.every((r) => r.shown.length === 1 && r.shown[0] === r.job && r.boxes === 6 && r.steps === 4 && r.termOpacity === '1' && r.right <= r.iw);
    record(ok, `業務を選ぶと図が切り替わり、完成形（6つの手作業 → 4工程 → 黄の端子）になる [${label}]`,
      res.map((r) => `${r.job}: 表示${r.shown.join(',')} 箱${r.boxes} 工程${r.steps} 端子opacity=${r.termOpacity}`).join(' / '));
  }

  // =========================================================================
  // 5. reduced-motion: 動いているものが0。完成状態が即座に出る
  // =========================================================================
  await load(1280, 900, { reduce: true });
  {
    const m = JSON.parse(await evaluate(`(() => {
      const running = document.getAnimations().filter(a => a.playState === 'running').length;
      const pane = [...document.querySelectorAll('.wire-pane')].find(p => p.getBoundingClientRect().width > 0);
      const term = getComputedStyle(pane.querySelector('.wire-after'), '::after');
      return JSON.stringify({ running, termOpacity: term.opacity, termAnim: term.animationName,
        scroll: getComputedStyle(document.documentElement).scrollBehavior });
    })()`));
    record(m.running === 0 && m.termOpacity === '1' && m.termAnim === 'none' && m.scroll === 'auto',
      'prefers-reduced-motion で動いているものが0で、完成状態が即座に出る',
      `実行中のアニメーション ${m.running}個 / 端子 opacity:${m.termOpacity} animation:${m.termAnim} / scroll-behavior:${m.scroll}`);
  }
  await load(1280, 900);
  {
    // 通常時: アニメーションは有限で、無限に繰り返すものが無い
    const m = JSON.parse(await evaluate(`(() => {
      const all = document.getAnimations({ subtree: true });
      return JSON.stringify({ n: all.length, infinite: all.filter(a => a.effect.getComputedTiming().iterations === Infinity).length });
    })()`));
    const appSrc = readFileSync(join(ROOT, 'assets/js/app.js'), 'utf8');
    const scrollListener = /addEventListener\(\s*['"]scroll['"]/.test(appSrc);
    record(m.infinite === 0 && !scrollListener, '無限に繰り返すアニメーションが無く、scroll イベントを使っていない',
      `通常時の実行中アニメーション ${m.n}個 / 無限 ${m.infinite}個 / app.js の scroll リスナー ${scrollListener ? 'あり' : 'なし'}`);
  }

  // =========================================================================
  // 6. スクロール連動: 画面に入ったセクションの端子が現在地になり、導線が濃くなる
  // =========================================================================
  await load(1280, 900);
  {
    await evaluate(`document.querySelector('#skills > h2').scrollIntoView({ behavior: 'instant', block: 'center' }); 1`);
    await sleep(700);
    const m = JSON.parse(await evaluate(`(() => {
      const cur = [...document.querySelectorAll('.sec.is-current')].map(s => s.id);
      const dot = getComputedStyle(document.querySelector('#skills > h2'), '::after').backgroundColor;
      const read = getComputedStyle(document.querySelector('.rail')).getPropertyValue('--read');
      return JSON.stringify({ cur, dot, read });
    })()`));
    record(m.cur.length === 1 && m.cur[0] === 'skills' && parseFloat(m.read) > 0 && m.dot === 'rgb(232, 177, 13)',
      '画面に入ったセクションの端子が黄になり、読んだところまで導線が濃くなる',
      `現在地 ${m.cur.join(',') || 'なし'} / 端子 ${m.dot} / 導線の濃い部分 ${m.read}`);
  }

  // =========================================================================
  // 7. キーボード: 全部の操作部品に Tab で届く。フォーカス表示が見える
  // =========================================================================
  for (const theme of ['light', 'dark']) {
    await load(1280, 900, { theme });
    const exp = JSON.parse(await evaluate(`(() => {
      ${VIS}
      const sel = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled])';
      const els = [...document.querySelectorAll(sel)].filter(el => vis(el) && el.tabIndex >= 0);
      const groups = new Set(); let n = 0;
      els.forEach((el, i) => { el.setAttribute('data-kb', String(i)); if (el.type === 'radio') groups.add(el.name); else n += 1; });
      return JSON.stringify({ expected: n + groups.size });
    })()`));
    await evaluate('document.activeElement && document.activeElement.blur(); scrollTo(0, 0); 1');
    const reached = new Set();
    for (let i = 0; i < exp.expected + 6; i++) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      }
      const key = await evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return ''; return a.type === 'radio' ? 'r:' + a.name : (a.getAttribute('data-kb') || ''); })()`);
      if (key) reached.add(key);
    }
    record(reached.size >= exp.expected, `全部の操作部品にキーボードで届く [${theme}]`, `Tab で ${reached.size} / 必要 ${exp.expected} 個に到達（ラジオはグループごとに1つ）`);

    // フォーカスの見え方: 二重線（黄の outline ＋ ink の影）で、ink 側が背景に対して 3:1 以上
    await evaluate(`document.querySelector('.hero .btn, .head__cta').focus(); document.querySelector('.head__cta').focus(); 1`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    const f = JSON.parse(await evaluate(`(() => {
      const el = document.querySelector('.head__cta');
      el.focus({ focusVisible: true });
      const cs = getComputedStyle(el);
      const rs = getComputedStyle(document.documentElement);
      return JSON.stringify({ w: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, shadow: cs.boxShadow,
        ink: rs.getPropertyValue('--ink').trim(), paper: rs.getPropertyValue('--paper').trim(), match: el.matches(':focus-visible') });
    })()`));
    const inkRatio = ratio(f.ink, f.paper);
    record(parseFloat(f.w) >= 2 && f.style === 'solid' && f.shadow !== 'none' && inkRatio >= 3,
      `フォーカス表示が二重線で、背景に対して3:1以上 [${theme}]`,
      `outline ${f.w} ${f.style} ${f.color} / 影 ${f.shadow.slice(0, 40)} / ink×paper=${inkRatio.toFixed(2)}:1`);
  }

  // =========================================================================
  // 8. タップ領域: 操作部品は 44×44px 以上（スマホ）
  // =========================================================================
  await load(390, 844);
  {
    const bad = JSON.parse(await evaluate(`(() => {
      ${VIS}
      const out = [];
      const targets = document.querySelectorAll('button, .btn, .head__cta, select, input[type=text], .opt');
      for (const el of targets) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || r.width < 43.5) out.push((el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      return JSON.stringify(out);
    })()`));
    record(bad.length === 0, 'スマホで、操作部品のタップ領域が 44×44px 以上', bad.length ? '足りない: ' + bad.slice(0, 5).join(', ') : 'button・.btn・select・input・選択肢をすべて検査');
  }

  // =========================================================================
  // 9. 触れるデモ3つ
  // =========================================================================
  await load(1280, 900);
  {
    // --- Excel管理表 ---
    const q = async (js) => JSON.parse(await evaluate(`JSON.stringify((() => { ${js} })())`));
    const sheet = '#demo-sheet';
    const totals = () => q(`const d = document.querySelector('${sheet}'); return { in: d.querySelector('[data-t=in]').textContent, ex: d.querySelector('[data-t=ex]').textContent, bal: d.querySelector('[data-t=bal]').textContent, rows: [...d.querySelectorAll('tbody tr')].filter(r => !r.hidden).map(r => r.dataset.m).join(',') };`);
    const before = await totals();
    await evaluate(`(() => { const d = document.querySelector('${sheet}'); d.querySelector('[data-f=month]').value = '7'; d.querySelector('[data-f=kind]').value = 'ex'; d.querySelector('[data-f=amount]').value = '３０，０００'; d.querySelector('[data-act=add]').click(); return 1; })()`);
    const after = await totals();
    const msgOk = await q(`return [...document.querySelectorAll('${sheet} [data-msg]')].filter(s => !s.hidden).map(s => s.dataset.msg).join();`);
    await evaluate(`(() => { const d = document.querySelector('${sheet}'); d.querySelector('[data-f=amount]').value = 'abc'; d.querySelector('[data-act=add]').click(); return 1; })()`);
    const bad = await totals();
    const badMsg = await q(`return [...document.querySelectorAll('${sheet} [data-msg]')].filter(s => !s.hidden).map(s => s.dataset.msg).join();`);
    await evaluate(`document.querySelector('${sheet} [data-act=reset]').click(); 1`);
    const reset = await totals();
    record(before.in === '255,000' && after.ex === '73,500' && after.bal === '181,500' && after.rows === '4,5,6,7' && msgOk === 'added' &&
      bad.ex === '73,500' && badMsg === 'bad' && reset.ex === '43,500' && reset.rows === '4,5,6',
      'Excel管理表のデモ: 追加で集計が変わり、不正な金額は弾かれ、元に戻せる',
      `最初 経費${before.ex || ''}合計 収入${before.in} → 追加後 経費${after.ex} 収支${after.bal} 行${after.rows} → 不正入力 ${badMsg} → リセット 経費${reset.ex}`);

    // --- リスト整形 ---
    const list = '#demo-list';
    const cnt = () => q(`const d = document.querySelector('${list}'); const t = d.querySelector('.list-live'); return { rows: [...t.querySelectorAll('tbody tr')].filter(r => !r.hidden).length, changed: t.querySelectorAll('.is-changed').length, msg: [...d.querySelectorAll('[data-msg]')].filter(s => !s.hidden).map(s => s.dataset.msg + ':' + (s.querySelector('.n') ? s.querySelector('.n').textContent : '')).join(), firstName: t.querySelector('tbody tr td').textContent };`);
    const l0 = await cnt();
    await evaluate(`document.querySelector('${list} [data-act=unify]').click(); 1`);
    const l1 = await cnt();
    await evaluate(`document.querySelector('${list} [data-act=dedupe]').click(); 1`);
    await sleep(1000);
    const l2 = await cnt();
    await evaluate(`document.querySelector('${list} [data-act=reset]').click(); 1`);
    const l3 = await cnt();
    await evaluate(`document.querySelector('${list} [data-act=dedupe]').click(); 1`);
    await sleep(1000);
    const l4 = await cnt();
    await evaluate(`document.querySelector('${list} [data-act=reset]').click(); 1`);
    record(l0.rows === 10 && l1.changed === 6 && l1.msg === 'unify-done:6' && l1.firstName === '株式会社みどり薬局' &&
      l2.rows === 7 && l2.msg === 'dedupe-done:3' && l3.rows === 10 && l3.changed === 0 && l3.firstName === '（株）みどり薬局' &&
      l4.rows === 7 && l4.msg === 'dedupe-done:3',
      'リスト整形のデモ: 統一で6件、重複削除で3件が変わり、元に戻せる（順番を変えても同じ）',
      `10行 → 統一 ${l1.changed}セル(${l1.msg}) → 削除 ${l2.rows}行(${l2.msg}) → 戻す ${l3.rows}行 → 削除だけ ${l4.rows}行`);

    // --- GAS実行 ---
    const gas = '#demo-gas';
    const g0 = await q(`const d = document.querySelector('${gas}'); return { log: d.querySelectorAll('.gas-log li.on').length, rows: d.querySelectorAll('.gas-row.on').length, ng: d.querySelectorAll('.gas-ng.on').length, done: d.querySelector('[data-done]').classList.contains('on') };`);
    await evaluate(`document.querySelector('${gas} [data-act=run]').click(); 1`);
    await sleep(1200);
    const gMid = await q(`const d = document.querySelector('${gas}'); return { log: d.querySelectorAll('.gas-log li.on').length, done: d.querySelector('[data-done]').classList.contains('on') };`);
    await sleep(3600);
    const g1 = await q(`const d = document.querySelector('${gas}'); return { log: d.querySelectorAll('.gas-log li.on').length, rows: d.querySelectorAll('.gas-row.on').length, ng: d.querySelectorAll('.gas-ng.on').length, done: d.querySelector('[data-done]').classList.contains('on'), again: !d.querySelector('[data-lbl=again]').hidden, busy: d.hasAttribute('aria-busy') };`);
    record(g0.log === 0 && g0.rows === 0 && gMid.log > 0 && gMid.log < 9 && !gMid.done && g1.log === 9 && g1.rows === 5 && g1.ng === 1 && g1.done && g1.again && !g1.busy,
      'GAS実行のデモ: ログが1行ずつ流れ、表が埋まり、最後に結果が出る',
      `実行前 ログ${g0.log} → 途中 ログ${gMid.log} → 完了 ログ${g1.log}行・表${g1.rows}行・要確認${g1.ng}行・結果文${g1.done ? '表示' : 'なし'}`);
  }

  // =========================================================================
  // 10. タブ
  // =========================================================================
  await load(1280, 900);
  {
    const q = async (js) => JSON.parse(await evaluate(`JSON.stringify((() => { ${js} })())`));
    const state = () => q(`${VIS} return { lp: vis(document.getElementById('panel-lp')), mech: vis(document.getElementById('panel-mech')), sel: [...document.querySelectorAll('[role=tab]')].map(t => t.getAttribute('aria-selected')).join() };`);
    const t0 = await state();
    await evaluate(`document.getElementById('tab-mech').click(); 1`);
    const t1 = await state();
    await evaluate(`document.getElementById('tab-mech').focus(); 1`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    const t2 = await state();
    await evaluate(`document.getElementById('tab-mech').click(); document.querySelector('[data-open-tab=lp]').click(); 1`);
    const t3 = await state();
    record(t0.lp && !t0.mech && t1.mech && !t1.lp && t2.lp && !t2.mech && t2.sel === 'true,false' && t3.lp && !t3.mech,
      '自主制作のタブ: クリックと矢印キーで切り替わり、「自主制作のLPを見る」でLPが開く',
      `初期 LP${t0.lp ? '○' : '×'}/仕組み${t0.mech ? '○' : '×'} → 仕組みをクリック LP${t1.lp ? '○' : '×'}/仕組み${t1.mech ? '○' : '×'} → ← キー ${t2.sel}`);
  }

  // =========================================================================
  // 11. 頼めるか診断（分岐）と、?from= による出し分け
  // =========================================================================
  const diagRun = async (answers) => JSON.parse(await evaluate(`(() => {
    const diag = document.querySelector('.diag-live');
    document.querySelector('[data-act=diag-reset]').click();
    for (const [name, value] of ${JSON.stringify(answers)}) { const el = diag.querySelector('input[name="' + name + '"][value="' + value + '"]'); if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); } }
    const shown = [...diag.querySelectorAll('[data-result]')].filter(r => !r.hidden);
    const r = shown[0];
    const card = r && r.querySelector('.pkg');
    const q3 = diag.querySelector('[data-q=q3]');
    return JSON.stringify({ keys: shown.map(s => s.dataset.result), card: card ? card.querySelector('h3').textContent : '', q3: !q3.hidden,
      btns: r ? [...r.querySelectorAll('.btns a')].filter(a => a.getBoundingClientRect().width > 0).map(a => a.dataset.only) : [] });
  })()`));

  await load(1280, 900);
  {
    const cases = [
      ['リスト＋チャット → 相談', [['q1', 'list'], ['q2', 'chat']], 'consult', ''],
      ['表＋チャット → 相談', [['q1', 'sheet'], ['q2', 'chat']], 'consult', ''],
      ['LP＋チャット → 相談', [['q1', 'lp'], ['q2', 'chat']], 'consult', ''],
      ['それ以外＋チャット → 相談', [['q1', 'other'], ['q2', 'chat']], 'consult', ''],
      ['自動化(LINE) → パッケージ', [['q1', 'auto'], ['q2', 'chat'], ['q3', 'line']], 'pkg', 'LINEに送るだけ'],
      ['自動化(転記集計) → パッケージ', [['q1', 'auto'], ['q2', 'chat'], ['q3', 'gas']], 'pkg', 'スプレッドシートの転記'],
      ['自動化(入金消込) → パッケージ', [['q1', 'auto'], ['q2', 'chat'], ['q3', 'recon']], 'pkg', '入金消込'],
      ['自動化(請求書PDF・URL未設定) → 相談', [['q1', 'auto'], ['q2', 'chat'], ['q3', 'denchoho']], 'consult', ''],
      ['自動化(どれにも当てはまらない) → 相談', [['q1', 'auto'], ['q2', 'chat'], ['q3', 'none']], 'consult', ''],
      ['税務＋チャット → 条件が合いません(B)', [['q1', 'tax'], ['q2', 'chat']], 'ng-b', ''],
      ['リスト＋通話 → 条件が合いません(A)', [['q1', 'list'], ['q2', 'call']], 'ng-a', ''],
      ['リスト＋訪問 → 条件が合いません(A)', [['q1', 'list'], ['q2', 'visit']], 'ng-a', ''],
      ['税務＋通話 → (A)が先', [['q1', 'tax'], ['q2', 'call']], 'ng-a', ''],
      ['自動化＋通話（問3未回答）→ (A)', [['q1', 'auto'], ['q2', 'call']], 'ng-a', '']
    ];
    const bad = [];
    for (const [name, answers, key, cardText] of cases) {
      const r = await diagRun(answers);
      if (r.keys.join() !== key || (cardText && !r.card.includes(cardText))) bad.push(`${name}（実際: ${r.keys.join() || 'なし'}${r.card ? ' / ' + r.card.slice(0, 12) : ''}）`);
    }
    const q3a = await diagRun([['q1', 'auto']]);
    const q3b = await diagRun([['q1', 'list']]);
    const noResult = await diagRun([['q1', 'auto'], ['q2', 'chat']]);
    record(bad.length === 0 && q3a.q3 && !q3b.q3 && noResult.keys.length === 0,
      `頼めるか診断: ${cases.length}通りの分岐が §4.7 の表どおりに判定され、問3は「作業の自動化」のときだけ出る`,
      bad.length ? 'ずれ: ' + bad.join(' / ') : `全${cases.length}通り一致 / 問3 ${q3a.q3 ? '自動化で表示' : '×'}・他で${q3b.q3 ? '×表示' : '非表示'} / 未回答なら結果なし`);
  }

  // ---- ?from= の出し分け ----
  const channelState = async () => JSON.parse(await evaluate(`(() => {
    const shown = (sel) => [...document.querySelectorAll(sel)].some(el => el.getBoundingClientRect().width > 0);
    return JSON.stringify({
      channel: document.documentElement.dataset.channel,
      packages: shown('#packages'),
      lc: shown('#contact [data-only=lc]'), cw: shown('#contact [data-only=cw]'),
      stats: shown('.stats'), headerCta: shown('.head__cta')
    });
  })()`));
  {
    const rows = [];
    for (const [query, want] of [
      ['', { channel: 'both', packages: true, lc: true, cw: true }],
      ['?from=lc', { channel: 'lc', packages: true, lc: true, cw: false }],
      ['?from=cw', { channel: 'cw', packages: false, lc: false, cw: true }],
      ['?from=xx', { channel: 'both', packages: true, lc: true, cw: true }]
    ]) {
      await load(1280, 900, { query });
      const s = await channelState();
      const ok = Object.entries(want).every(([k, v]) => s[k] === v) && s.stats && s.headerCta;
      rows.push({ query: query || '（なし）', ok, s });
    }
    record(rows.every((r) => r.ok), '?from= による出し分けが §7 の表どおり（評価の数字は常に出る）',
      rows.map((r) => `${r.query}: パッケージ${r.s.packages ? '○' : '×'} LC${r.s.lc ? '○' : '×'} CW${r.s.cw ? '○' : '×'}`).join(' / '));

    // ページ内の移動（ハッシュ）後も、決めた値が保たれる
    await load(1280, 900, { query: '?from=cw' });
    await evaluate(`location.hash = '#skills'; 1`);
    await sleep(300);
    const kept = await channelState();
    // CW から来た人には、診断でもパッケージを出さない
    const viaCw = await diagRun([['q1', 'auto'], ['q2', 'chat'], ['q3', 'line']]);
    await load(1280, 900, { query: '?from=lc' });
    const viaLc = await diagRun([['q1', 'auto'], ['q2', 'chat'], ['q3', 'line']]);
    const viaLcConsult = await diagRun([['q1', 'list'], ['q2', 'chat']]);
    await load(1280, 900, { query: '?from=cw' });
    const viaCwConsult = await diagRun([['q1', 'list'], ['q2', 'chat']]);
    record(kept.channel === 'cw' && !kept.packages && viaCw.keys.join() === 'consult' && viaLc.keys.join() === 'pkg' &&
      viaLcConsult.btns.join() === 'lc' && viaCwConsult.btns.join() === 'cw',
      '?from=cw では診断もパッケージを返さず、結果のボタンも来た場所に合わせる。ハッシュ移動後も保たれる',
      `移動後 ${kept.channel}・パッケージ${kept.packages ? '○' : '×'} / CW+自動化→${viaCw.keys.join()} / LC+自動化→${viaLc.keys.join()} / 相談ボタン LC:${viaLcConsult.btns.join()} CW:${viaCwConsult.btns.join()}`);
  }

  // =========================================================================
  // 12. ダークモード: OS設定に従い、ボタンで切り替わり、保存される
  // =========================================================================
  await load(1280, 900, { theme: 'dark' });
  {
    const css = (n) => `getComputedStyle(document.documentElement).getPropertyValue('${n}').trim()`;
    const d0 = JSON.parse(await evaluate(`JSON.stringify({ paper: ${css('--paper')}, bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme || '' })`));
    await evaluate(`document.querySelector('.theme-toggle').click(); 1`);
    const d1 = JSON.parse(await evaluate(`JSON.stringify({ paper: ${css('--paper')}, theme: document.documentElement.dataset.theme, saved: localStorage.getItem('theme'), pressed: document.querySelector('.theme-toggle').getAttribute('aria-pressed') })`));
    await send('Page.reload');
    await sleep(1500);
    const d2 = JSON.parse(await evaluate(`JSON.stringify({ paper: ${css('--paper')}, theme: document.documentElement.dataset.theme || '' })`));
    record(d0.paper === '#0E1520' && d0.theme === '' && d1.paper === '#EDF0F2' && d1.theme === 'light' && d1.saved === 'light' && d2.paper === '#EDF0F2' && d2.theme === 'light',
      'ダークモード: OSの設定に従い、ボタンで切り替わり、選んだ値が再読み込み後も残る',
      `OSダーク ${d0.paper} → ボタン ${d1.paper}(保存:${d1.saved}) → 再読み込み ${d2.paper}`);
  }

  // =========================================================================
  // 13. コントラスト（ライト・ダーク、初期状態と、開いた・実行した状態）
  // =========================================================================
  const scanExpr = `(() => {
    const parse = (c) => {
      let m;
      if ((m = c.match(/^rgba?\\(([^)]+)\\)/))) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
      if ((m = c.match(/^color\\(srgb ([^)]+)\\)/))) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
      return [255, 255, 255, 1];
    };
    const bgOf = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 0.99) break; }
      let out = layers.length && layers[layers.length - 1][3] >= 0.99 ? layers[layers.length - 1].slice(0, 3) : [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) { const [r, g, b, a] = layers[i]; out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)]; }
      return out;
    };
    const L = (rgb) => { const [r, g, b] = rgb.map(v => v / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bad = []; let n = 0; let min = 99;
    for (const el of document.querySelectorAll('body *')) {
      if (![...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || !el.getClientRects().length || el.closest('.is-doomed, .sr')) continue;
      n += 1;
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const r = ratio(fg.slice(0, 3), bg);
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      min = Math.min(min, r);
      if (r < (large ? 3 : 4.5)) bad.push((el.className || el.tagName) + '「' + el.textContent.trim().slice(0, 10) + '」' + r.toFixed(2));
    }
    return JSON.stringify({ n, min: Math.round(min * 100) / 100, bad: bad.slice(0, 5) });
  })()`;
  const expandAll = async () => {
    // 閉じているもの・結果が出るものを一通り開く
    await evaluate(`(() => {
      document.querySelector('#demo-gas [data-act=run]').click();
      document.querySelector('#demo-list [data-act=unify]').click();
      document.querySelector('#demo-sheet [data-act=add]').click();
      return 1; })()`);
    await sleep(4200);
  };
  for (const theme of ['light', 'dark']) {
    await load(1280, 900, { theme });
    const s0 = JSON.parse(await evaluate(scanExpr));
    await expandAll();
    await diagRun([['q1', 'tax'], ['q2', 'chat']]);
    const s1 = JSON.parse(await evaluate(scanExpr));
    await diagRun([['q1', 'auto'], ['q2', 'chat'], ['q3', 'line']]);
    const s2 = JSON.parse(await evaluate(scanExpr));
    await evaluate(`document.getElementById('tab-mech').click(); 1`);
    const s3 = JSON.parse(await evaluate(scanExpr));
    const bad = [...s0.bad, ...s1.bad, ...s2.bad, ...s3.bad];
    record(bad.length === 0, `描画されている全テキストが WCAG AA のコントラストを満たす [${theme}]`,
      bad.length ? bad.join(' / ') : `初期${s0.n}・実行後${s1.n}・診断結果${s2.n}・仕組みタブ${s3.n}箇所を検査。最小 ${Math.min(s0.min, s1.min, s2.min, s3.min)}:1`);
  }
  {
    // 導線・枠線の色（非テキスト）: --line と --paper が 3:1 以上
    await load(1280, 900, { theme: 'light' });
    const t = JSON.parse(await evaluate(`(() => { const s = getComputedStyle(document.documentElement); return JSON.stringify({ line: s.getPropertyValue('--line').trim(), paper: s.getPropertyValue('--paper').trim(), deep: s.getPropertyValue('--paper-deep').trim() }); })()`));
    await load(1280, 900, { theme: 'dark' });
    const d = JSON.parse(await evaluate(`(() => { const s = getComputedStyle(document.documentElement); return JSON.stringify({ line: s.getPropertyValue('--line').trim(), paper: s.getPropertyValue('--paper').trim() }); })()`));
    const a = ratio(t.line, t.paper), b = ratio(d.line, d.paper);
    record(a >= 4.5 && b >= 4.5, '--line と --paper のコントラスト比が4.5:1以上（リンク文字にも使うため）', `ライト ${t.line} / ${t.paper} = ${a.toFixed(2)}:1、ダーク ${d.line} / ${d.paper} = ${b.toFixed(2)}:1`);
  }

  // =========================================================================
  // 14. 書体: ページの全文字がサブセットに入っている。指定外の書体で描かれていない
  // =========================================================================
  await load(1280, 900);
  {
    const page = await evaluate(`(() => {
      let s = document.title;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      while (w.nextNode()) s += w.currentNode.textContent;
      for (const el of document.querySelectorAll('[alt],[aria-label],[title],[placeholder],[data-fixed],[value]')) for (const a of ['alt','aria-label','title','placeholder','data-fixed','value']) s += el.getAttribute(a) || '';
      for (const el of document.querySelectorAll('*')) for (const p of ['::before','::after']) { const c = getComputedStyle(el, p).content; if (c && c !== 'none' && c !== 'normal') s += c.replace(/^"|"$/g, ''); }
      return s;
    })()`);
    const charsetFile = join(ROOT, 'assets/fonts/charset.txt');
    if (!existsSync(charsetFile)) {
      record(false, 'ページの全文字がフォントのサブセットに入っている', 'assets/fonts/charset.txt が無い（node tools/fonts.mjs を流す）');
    } else {
      const have = new Set(readFileSync(charsetFile, 'utf8').replace(/\s/g, ''));
      const missing = [...new Set(page.replace(/\s/g, ''))].filter((c) => !have.has(c));
      record(missing.length === 0, 'ページの全文字がフォントのサブセットに入っている（隠れた文言・属性・生成内容を含む）',
        missing.length ? `足りない字: ${missing.join('')}（node tools/font-url.mjs → node tools/fonts.mjs で作り直す）` : `${new Set(page.replace(/\s/g, '')).size}字を、サブセット ${have.size}字と突き合わせた`);
    }

    // 実際に描画に使われた書体（フォールバックしていないか）を、全要素について見る
    const doc = await send('DOM.getDocument', { depth: 1 });
    const all = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'body, body *' });
    const tally = new Map();
    const stray = [];
    for (const nodeId of all.result.nodeIds) {
      const p = await send('CSS.getPlatformFontsForNode', { nodeId });
      for (const f of (p.result && p.result.fonts) || []) {
        if (!f.glyphCount) continue;
        tally.set(f.familyName, (tally.get(f.familyName) || 0) + f.glyphCount);
        if (!/^(Zen Kaku Gothic New|Inter Tight)$/.test(f.familyName) && stray.length < 3) {
          const d = await send('DOM.describeNode', { nodeId });
          stray.push(`${d.result.node.localName}「${f.familyName}」${f.glyphCount}字`);
        }
      }
    }
    record(stray.length === 0, '本文が指定書体だけで描画されている（サブセット漏れがない）',
      [...tally].map(([k, v]) => `${k} ${v}字`).join(' / ') + (stray.length ? ' ← 指定外: ' + stray.join(', ') : ''));
  }

  // =========================================================================
  // 15. JavaScript を止めても、全セクションの文言が読める
  // =========================================================================
  await load(1280, 900, { js: false });
  {
    const squash = (s) => s.replace(/\s+/g, '');
    const text = squash(await evaluate('document.body.innerText'));
    const must = [
      ['ヒーローのキャッチ', '手で繰り返している作業を、自動で回る仕組みにします'],
      ['本人', 'プロジェクトリーダーをしています'],
      ['図の説明（業務を選ぶ）', '自動化前（手作業の6工程）'],
      ['評価の数字', 'クラウドワークス評価'],
      ['稼働条件', '平日は21時以降と、土日祝に対応しています'],
      ['実績1', '家賃・経費を1行ずつ入力するだけで'], ['実績2', '次回も相談したいと思います'],
      ['実績3', '急な依頼を要望通りにやって頂きありがとうございました'], ['実績4', '本番まで伴走までして頂き本当にありがとうございました'],
      ['実績5', 'とても丁寧に対応いただきました'],
      ['税務の注記', '税務相談や申告書の作成代行は行っていません'],
      ['リスト整形（整形後の表）', '整形後の店舗リスト'], ['Excel管理表（結果の表）', '年間合計'],
      ['GAS実行（結果）', '5件を記録しました。1件は形式が読み取れなかったため'],
      ['自主制作 LP タブ', 'BLOOM（架空の美容室）'], ['自主制作 仕組みタブ', 'GAS勤怠管理'], ['仕組みタブ（突合）', '売上・入金データの夜間自動突合'],
      ['パッケージ', '15,000円〜'], ['パッケージ名', '入金消込（売上と入金の突合）をGASで自動化'],
      ['診断（判定の表）', '作業の自動化で、LINEの報告'], ['診断（結果A）', 'すみません、この条件ではお受けできません'],
      ['診断（結果の相談）', '内容を伺ってから判断します'],
      ['進め方', '引き渡し'], ['資格', 'Microsoft Azure Fundamentals'], ['依頼先（LC）', 'ランサーズで相談する'], ['依頼先（CW）', 'クラウドワークスで相談する']
    ];
    const missing = must.filter(([, t]) => !text.includes(squash(t))).map(([n]) => n);
    const hiddenOk = !text.includes(squash("請求書PDFを電帳法対応の名前に自動リネーム・整理")); // URL 未設定のカードは出さない
    const toggle = await evaluate(`getComputedStyle(document.querySelector('.theme-toggle')).display`);
    const live = await evaluate(`getComputedStyle(document.querySelector('.diag-live')).display`);
    record(missing.length === 0 && hiddenOk && toggle === 'none' && live === 'none',
      'JavaScript を止めても全セクションの文言が読める（操作部品だけが隠れる）',
      missing.length ? '読めない: ' + missing.join(', ') : `${must.length}か所の文言を確認 / 切り替えボタン・診断の入力欄は非表示 / URL未設定のカードは出ない`);
  }

  // =========================================================================
  // 16. LC・CW の外で直接やり取りする導線が無い。料金はパッケージの欄の中だけ
  // =========================================================================
  await load(1280, 900);
  {
    const src = await (await fetch(BASE)).text();
    const found = [];
    if (/mailto:/i.test(src)) found.push('mailto:');
    if (/\btel:/i.test(src)) found.push('tel:');
    if (/<form[\s>]/i.test(src)) found.push('<form>');
    if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(src.replace(/@font-face|@media|@keyframes|@supports/g, ''))) found.push('メールアドレスらしい文字列');
    const links = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')))`));
    const external = links.filter((h) => /^https?:/.test(h)).filter((h) => !/^https:\/\/(www\.lancers\.jp|crowdworks\.jp|wada3333\.github\.io|github\.com\/wada3333)/.test(h));
    record(found.length === 0 && external.length === 0, 'LC・CW の外で直接やり取りする導線（フォーム・メール・電話・外部の連絡先）が無い',
      found.length || external.length ? `検出: ${[...found, ...external].join(', ')}` : `リンク ${links.length} 本はすべて ランサーズ / クラウドワークス / 自作ページ / GitHub`);

    const yen = JSON.parse(await evaluate(`(() => {
      const bad = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const n = w.currentNode; if (/円/.test(n.textContent) && !n.parentElement.closest('.pkg')) bad.push(n.textContent.trim().slice(0, 24)); }
      const prices = [...document.querySelectorAll('.pkg .price')].map(p => p.textContent.trim());
      return JSON.stringify({ bad, prices });
    })()`));
    record(yen.bad.length === 0 && yen.prices.join() === '15,000円〜,10,000円〜,15,000円〜,15,000円〜',
      '料金は、ランサーズのパッケージの価格（「〜」付き）だけ',
      yen.bad.length ? '欄の外に「円」: ' + yen.bad.join(' / ') : `「円」を含む文字列はすべてパッケージの欄の中。価格 ${yen.prices.join(' / ')}`);

    const blank = await evaluate(`(() => { const a = [...document.querySelectorAll('a[target=_blank]')]; return JSON.stringify({ n: a.length, bad: a.filter(x => !/noopener/.test(x.rel) || !/noreferrer/.test(x.rel)).length }); })()`);
    const b = JSON.parse(blank);
    record(b.bad === 0, '別タブで開くリンクに rel="noopener noreferrer" が付いている', `${b.n}本を検査`);

    const todo = JSON.parse(await evaluate(`JSON.stringify({ marks: [...document.querySelectorAll('[data-todo]')].map(el => (el.closest('#pkg-denchoho') ? 'denchoho' : 'other:' + el.tagName.toLowerCase())), cardHidden: document.getElementById('pkg-denchoho').hidden, href: document.querySelector('#pkg-denchoho a').getAttribute('href') })`));
    // 「要記入」が残るのは請求書PDFのパッケージ（URL）だけ。残っている間はカードを出さない。URL を入れて印を外したら、カードを出してよい
    const stray = todo.marks.filter((m) => m !== 'denchoho');
    const open = todo.marks.length > 0;
    record(stray.length === 0 && (!open || (todo.cardHidden && todo.href === '#')) && (open || (!todo.cardHidden && /^https:\/\/www\.lancers\.jp\/menu\/detail\/\d+$/.test(todo.href))),
      '「要記入」が残るのは請求書PDFのパッケージのURLだけで、残っている間そのカードは出ない（解消したらURLが入ってカードが出る）',
      open ? `要記入あり（請求書PDFのパッケージのURL）。カードは非表示` : `解消済み: ${todo.href}`);
  }

  // =========================================================================
  // 17. 見出しの順序、OGP
  // =========================================================================
  await load(1280, 900);
  {
    const heads = await evaluate(`[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1])`);
    let jump = null;
    for (let i = 1; i < heads.length; i++) if (heads[i] - heads[i - 1] > 1) jump = `${heads[i - 1]} -> ${heads[i]}`;
    record(heads[0] === 1 && heads.filter((h) => h === 1).length === 1 && !jump, '見出しが h1 → h2 → h3 → h4 の順序を崩さない',
      jump ? '飛び: h' + jump : `h1×1 / 全${heads.length}個、飛びなし`);

    const meta = JSON.parse(await evaluate(`(() => { const g = (s, a) => (document.querySelector(s) || {}).getAttribute ? document.querySelector(s).getAttribute(a) : ''; return JSON.stringify({
      ogImage: g('meta[property="og:image"]', 'content'), twImage: g('meta[name="twitter:image"]', 'content'),
      ogUrl: g('meta[property="og:url"]', 'content'), canonical: g('link[rel=canonical]', 'href'), ogTitle: g('meta[property="og:title"]', 'content'),
      desc: g('meta[name=description]', 'content'), ogDesc: g('meta[property="og:description"]', 'content') }); })()`));
    const abs = 'https://wada3333.github.io/portfolio/';
    record(meta.ogImage === abs + 'assets/og.png?v=3' && meta.twImage === meta.ogImage && meta.ogUrl === abs && meta.canonical === abs && meta.desc && meta.desc === meta.ogDesc,
      'OGP: og:image・twitter:image は絶対URLで ?v=3、og:url と canonical が設定されている', `og:image ${meta.ogImage}`);
    const og = join(ROOT, 'assets/og.png');
    const buf = readFileSync(og);
    const [ow, oh] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    record(ow === 1200 && oh === 630, 'assets/og.png が 1200×630', `${ow}×${oh}`);
  }

  // =========================================================================
  // 18. 公開範囲（§6.7）: 許可リストのファイルだけが _site に入り、ページが参照するものは全部ある
  // =========================================================================
  {
    const site = mkdtempSync(join(tmpdir(), 'pf-site-'));
    execFileSync(process.execPath, [join(HERE, 'make-site.mjs'), site], { stdio: 'ignore' });
    const walk = (d, base = d) => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1).replace(/\\/g, '/')];
    });
    const files = walk(site);
    const forbidden = ['portfolio-lp-spec.md', 'tools', 'docs', '.github', 'assets/og-bg.png', 'assets/fonts/charset.txt', '.gitignore', '.gitattributes']
      .filter((f) => files.some((x) => x === f || x.startsWith(f + '/')));
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(assets\/[^"?#]+)/g)].map((m) => m[1]);
    const jsRefs = [];
    const missing = [...new Set([...refs, ...jsRefs])].filter((r) => !files.includes(r));
    const imgFiles = readdirSync(join(ROOT, 'assets/images')).filter((n) => n.endsWith('.webp'));
    const unused = imgFiles.filter((n) => !html.includes('assets/images/' + n));
    record(forbidden.length === 0 && missing.length === 0 && files.includes('index.html') && files.includes('.nojekyll'),
      '公開範囲: 許可リストのファイルだけが入り、仕様書・docs/・tools/・OG画像の下地は入らない。ページの参照先はすべてある',
      forbidden.length || missing.length ? `入ってはいけない: ${forbidden.join(',')} / 足りない: ${missing.join(',')}` : `${files.length}ファイル（${files.filter((f) => f.endsWith('.js')).length} JS・${files.filter((f) => f.endsWith('.webp')).length} 画像・${files.filter((f) => f.endsWith('.woff2')).length} フォント）${unused.length ? ' / 使われていない画像: ' + unused.join(',') : ''}`);
    rmSync(site, { recursive: true, force: true });
  }

  // =========================================================================
  // 19. 本業に関わる語（一覧は公開しない。tools/banned-words.local.txt から読む）
  // =========================================================================
  await load(1280, 900);
  {
    const bannedFile = join(HERE, 'banned-words.local.txt');
    if (!existsSync(bannedFile)) {
      console.log('SKIP 本業に関わる語の検査 — tools/banned-words.local.txt が無いため飛ばした');
    } else {
      const lines = readFileSync(bannedFile, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
      const split = lines.indexOf('[page]');
      const everywhere = split < 0 ? lines : lines.slice(0, split);
      const pageOnly = split < 0 ? [] : lines.slice(split + 1);
      const banned = [...everywhere, ...pageOnly];
      const source = await (await fetch(BASE)).text();
      const pages = [source];
      for (const f of (source.match(/src="([^"]+\.js)"/g) || []).map((m) => m.slice(5, -1))) {
        try { pages.push(readFileSync(join(ROOT, f), 'utf8')); } catch { /* 無ければ飛ばす */ }
      }
      const shown = await evaluate('document.documentElement.textContent');
      const all = pages.join('\n') + '\n' + shown;
      const hits = banned.filter((w) => all.includes(w));
      record(hits.length === 0, '勤務先・実クライアントが特定されうる記述が配信ファイルに無い',
        hits.length ? `検出 ${hits.length} 語（語そのものは表示しない）` : `${banned.length}語すべて不検出（HTML・JS・表示テキスト）`);

      const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0').filter((p) => p && !/\.(png|webp|woff2|svg|mp4|ico)$/i.test(p));
      const leaked = [];
      for (const p of tracked) {
        let body = '';
        try { body = readFileSync(join(ROOT, p), 'utf8'); } catch { continue; }
        if (everywhere.some((w) => body.includes(w))) leaked.push(p);
      }
      record(leaked.length === 0, '公開リポジトリのファイル全体に、本業に関わる語が無い',
        leaked.length ? '検出したファイル: ' + leaked.join(', ') : `追跡中のテキスト ${tracked.length} ファイルを検査`);
    }
  }

  ws.close();
  const ng = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - ng} / ${results.length} 項目が OK` + (ng ? `（NG ${ng} 件）` : ''));
  process.exitCode = ng ? 1 : 0;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
