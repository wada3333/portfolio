/*
 * ポートフォリオLP のスクリプト（外部ライブラリなし・通信なし）
 * ---------------------------------------------------------------------------
 * 約束: 文言は全部 index.html に書いてある。ここでは「見せる／隠す」「数字を入れる」
 * 「選んだ要素を複製する」だけをして、文章を組み立てて差し込むことはしない。
 * （文字を組み立てると、フォントのサブセット生成に載らず、足した字だけ別の書体になるため）
 * 明るさの初期値と、?from= による導線の出し分けは <head> のインラインスクリプトで済ませてある。
 */

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const root = document.documentElement;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** data-msg を持つ要素のうち、key のものだけを出す */
function showMsg(scope, key, n) {
  for (const el of $$('[data-msg]', scope)) {
    const on = el.dataset.msg === key;
    el.hidden = !on;
    if (on && n !== undefined) {
      const slot = $('.n', el);
      if (slot) slot.textContent = String(n);
    }
  }
}

/* --- ダークモードの切り替え ------------------------------------------------ */
function initTheme() {
  const btn = $('.theme-toggle');
  if (!btn) return;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const effective = () => root.getAttribute('data-theme') || (mq.matches ? 'dark' : 'light');
  const sync = () => btn.setAttribute('aria-pressed', String(effective() === 'dark'));
  sync();
  btn.addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* 保存できない環境では、そのページの間だけ */ }
    sync();
  });
  mq.addEventListener('change', sync);
}

/* --- ヒーロー: 業務を選ぶ -------------------------------------------------- */
// 図の切り替えは CSS（:has と :checked）が行う。ここは読み上げのために、
// 選んだ図の要約（HTMLに書いてある文）を live 領域へ写すだけ。
function initWire() {
  const live = $('[data-wire-live]');
  if (!live) return;
  for (const input of $$('input[name="job"]')) {
    input.addEventListener('change', () => {
      const pane = $(`.wire-pane[data-job="${input.id.replace('job-', '')}"]`);
      const summary = pane && $('[data-summary]', pane);
      if (summary) live.textContent = summary.textContent;
    });
  }
}

/* --- 自主制作のタブ -------------------------------------------------------- */
function initTabs() {
  const tabs = $$('[role="tab"]');
  if (!tabs.length) return;
  const select = (tab, moveFocus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      // LP は初期状態で開いている（is-closed で閉じる）、仕組みは初期状態で閉じている（is-open で開く）
      if (panel.id === 'panel-lp') panel.classList.toggle('is-closed', !on);
      else panel.classList.toggle('is-open', on);
    }
    if (moveFocus) tab.focus();
  };
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const last = tabs.length - 1;
      let to = null;
      if (e.key === 'ArrowRight') to = i === last ? 0 : i + 1;
      else if (e.key === 'ArrowLeft') to = i === 0 ? last : i - 1;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = last;
      if (to !== null) { e.preventDefault(); select(tabs[to], true); }
    });
  }
  for (const link of $$('[data-open-tab]')) {
    link.addEventListener('click', () => select(tabs[link.dataset.openTab === 'lp' ? 0 : 1]));
  }
}

/* --- デモ1: Excel管理表（架空のデータ）------------------------------------- */
function initSheet() {
  const demo = $('#demo-sheet');
  if (!demo) return;
  const seed = [[4, 'in', 85000], [4, 'ex', 12000], [5, 'in', 85000], [5, 'ex', 8500], [6, 'in', 85000], [6, 'ex', 23000]];
  let entries = seed.map((e) => [...e]);
  const fmt = (n) => n.toLocaleString('en-US');
  const month = $('[data-f="month"]', demo);
  const kind = $('[data-f="kind"]', demo);
  const amount = $('[data-f="amount"]', demo);

  const render = () => {
    const income = Array(13).fill(0);
    const expense = Array(13).fill(0);
    const count = Array(13).fill(0);
    for (const [m, k, a] of entries) { (k === 'in' ? income : expense)[m] += a; count[m] += 1; }
    for (const tr of $$('tbody tr', demo)) {
      const m = Number(tr.dataset.m);
      const cells = $$('td', tr);
      cells[0].textContent = fmt(income[m]);
      cells[1].textContent = fmt(expense[m]);
      cells[2].textContent = fmt(income[m] - expense[m]);
      tr.hidden = count[m] === 0;
    }
    const sum = (list) => list.reduce((a, b) => a + b, 0);
    $('[data-t="in"]', demo).textContent = fmt(sum(income));
    $('[data-t="ex"]', demo).textContent = fmt(sum(expense));
    $('[data-t="bal"]', demo).textContent = fmt(sum(income) - sum(expense));
  };

  const add = () => {
    const raw = amount.value.normalize('NFKC').replace(/[,\s]/g, '');
    if (!/^\d{1,9}$/.test(raw) || Number(raw) === 0) { showMsg(demo, 'bad'); amount.focus(); return; }
    entries.push([Number(month.value), kind.value, Number(raw)]);
    render();
    showMsg(demo, 'added');
  };

  $('[data-act="add"]', demo).addEventListener('click', add);
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  $('[data-act="reset"]', demo).addEventListener('click', () => {
    entries = seed.map((e) => [...e]);
    render();
    showMsg(demo, 'reset');
  });
}

/* --- デモ2: リスト整形（架空のデータ）--------------------------------------- */
function initList() {
  const demo = $('#demo-list');
  const table = demo && $('.list-live', demo);
  if (!table) return;
  const rows = $$('tbody tr', table);
  for (const td of $$('td', table)) td.dataset.raw = td.textContent;
  const valueOf = (td) => td.dataset.fixed || td.dataset.raw;
  const buttons = $$('[data-act]', demo);
  const lock = (on) => { for (const b of buttons) b.disabled = on; };

  $('[data-act="unify"]', demo).addEventListener('click', () => {
    let changed = 0;
    for (const td of $$('td[data-fixed]', table)) {
      if (td.textContent !== td.dataset.fixed) {
        td.textContent = td.dataset.fixed;
        td.classList.add('is-changed');
        changed += 1;
      }
    }
    if (changed) showMsg(demo, 'unify-done', changed);
    else showMsg(demo, 'unify-none');
  });

  $('[data-act="dedupe"]', demo).addEventListener('click', async () => {
    const seen = new Set();
    const doomed = [];
    for (const tr of rows) {
      if (tr.hidden) continue;
      const cells = $$('td', tr);
      const key = `${valueOf(cells[0])}|${valueOf(cells[2])}`;
      if (seen.has(key)) doomed.push(tr); else seen.add(key);
    }
    if (!doomed.length) { showMsg(demo, 'dedupe-none'); return; }
    lock(true);
    for (const tr of doomed) tr.classList.add('is-doomed');
    if (!reduced()) await sleep(650);
    for (const tr of doomed) { tr.hidden = true; tr.classList.remove('is-doomed'); }
    showMsg(demo, 'dedupe-done', doomed.length);
    lock(false);
  });

  $('[data-act="reset"]', demo).addEventListener('click', () => {
    for (const tr of rows) { tr.hidden = false; tr.classList.remove('is-doomed'); }
    for (const td of $$('td', table)) { td.textContent = td.dataset.raw; td.classList.remove('is-changed'); }
    showMsg(demo, 'reset');
  });
}

/* --- デモ3: GAS実行（架空のデータ）------------------------------------------ */
function initGas() {
  const demo = $('#demo-gas');
  if (!demo) return;
  const run = $('[data-act="run"]', demo);
  const steps = $$('.gas-log li[data-step]', demo);
  const hint = $('.gas-hint', demo);
  const rows = $$('.gas-row', demo);
  const ng = $('.gas-ng', demo);
  const done = $('[data-done]', demo);
  const again = $('[data-lbl="again"]', demo);
  const first = $('[data-lbl="run"]', demo);
  let running = false;

  run.addEventListener('click', async () => {
    if (running) return;
    running = true;
    run.disabled = true;
    demo.setAttribute('aria-busy', 'true');
    hint.hidden = true;
    for (const el of [...steps, ...rows, ng, done]) el.classList.remove('on');
    for (const step of steps) {
      step.classList.add('on');
      if (step.dataset.row !== undefined) rows[Number(step.dataset.row)].classList.add('on');
      if (step.hasAttribute('data-ng')) ng.classList.add('on');
      if (!reduced()) await sleep(380);
    }
    done.classList.add('on');
    first.hidden = true;
    again.hidden = false;
    demo.removeAttribute('aria-busy');
    run.disabled = false;
    running = false;
  });
}

/* --- 頼めるか診断 ---------------------------------------------------------- */
function initDiag() {
  const diag = $('.diag-live');
  if (!diag) return;
  const value = (name) => { const el = $(`input[name="${name}"]:checked`, diag); return el ? el.value : ''; };
  const q3 = $('[data-q="q3"]', diag);
  const results = $$('[data-result]', diag);
  const slot = $('[data-result="pkg"] [data-slot]', diag);
  const cards = { line: '#pkg-line', gas: '#pkg-gas', recon: '#pkg-recon', denchoho: '#pkg-denchoho' };

  // 表に出ていないカード（パッケージ欄ごと隠れている / URL 未設定で hidden）は「出せる」と数えない
  const available = (card) => Boolean(card) && !card.hidden && card.offsetParent !== null;

  const update = () => {
    const a = value('q1');
    const b = value('q2');
    if (a !== 'auto') for (const el of $$('input[name="q3"]', diag)) el.checked = false;
    q3.hidden = a !== 'auto';
    const c = value('q3');

    let key = '';
    if (a && b) {
      if (b === 'call' || b === 'visit') key = 'ng-a';
      else if (a === 'tax') key = 'ng-b';
      else if (a === 'auto') {
        if (c) key = cards[c] && available($(cards[c])) ? 'pkg' : 'consult';
      } else key = 'consult';
    }

    if (key === 'pkg') {
      const clone = $(cards[c]).cloneNode(true);
      clone.removeAttribute('id');
      slot.replaceChildren(clone);
    }
    for (const r of results) r.hidden = r.dataset.result !== key;
  };

  diag.addEventListener('change', update);
  $('[data-act="diag-reset"]', diag).addEventListener('click', () => {
    for (const el of $$('input[type="radio"]', diag)) el.checked = false;
    update();
  });
  update();
}

/* --- スクロールに合わせて、導線と端子だけを動かす ---------------------------- */
// 画面に入ったセクションの端子が黄になり（現在地）、読んだところまで縦の導線が濃くなる。
// 文章や画像は動かさない。scroll イベントは使わず IntersectionObserver で行う。
function initRail() {
  const rail = $('.rail');
  const sections = $$('.sec');
  if (!rail || !sections.length || !('IntersectionObserver' in window)) return;
  const inBand = new Set();
  let current = null;

  const apply = () => {
    const hits = sections.filter((s) => inBand.has(s));
    if (hits.length) current = hits[hits.length - 1];
    else if (window.scrollY < sections[0].offsetTop - window.innerHeight * 0.5) current = null;
    for (const s of sections) s.classList.toggle('is-current', s === current);
    const h2 = current && $('h2', current);
    const top = h2 ? h2.getBoundingClientRect().top - rail.getBoundingClientRect().top + 8 : 0;
    rail.style.setProperty('--read', `${Math.max(0, Math.round(top))}px`);
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) { if (e.isIntersecting) inBand.add(e.target); else inBand.delete(e.target); }
    apply();
  }, { rootMargin: '-35% 0px -55% 0px' });
  for (const s of sections) io.observe(s);
  window.addEventListener('resize', apply);
}

initTheme();
initWire();
initTabs();
initSheet();
initList();
initGas();
initDiag();
initRail();
