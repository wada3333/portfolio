/**
 * Google Fonts のサブセットを自ドメインに取り込む（外部依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8130                              # 別ターミナルで起動
 *   node tools/fonts.mjs "$(node tools/font-url.mjs | tail -1)"
 *
 * tools/font-url.mjs が作る text= 付きURLの CSS を取得し、参照している woff2 を
 * assets/fonts/ に落として、index.html に貼る @font-face を出力する。
 *
 * URL は引数で渡す。index.html は自ドメイン配信に切り替えたあと Google Fonts の
 * <link> を持たないので、そこからは読めない。
 *
 * なぜ自ドメインに置くか:
 *   fonts.googleapis.com -> fonts.gstatic.com と別オリジンを2つ経由すると、
 *   モバイルの実効回線では DNS/TLS の往復だけで FCP が 3.0秒まで伸びる
 *   （Lighthouse Performance 89）。同一オリジンから配ると往復が消える。
 *   書体は Inter Tight / Zen Kaku Gothic New ともに SIL Open Font License で、
 *   再配布が認められている（assets/fonts/OFL.txt を同梱）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'fonts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** 第1引数の URL を使う。無ければ index.html の <link> から拾う（移行前の作り） */
const arg = process.argv[2];
const cssUrl = (arg && /^https:\/\/fonts\.googleapis\.com\/css2\?/.test(arg)
  ? arg
  : (() => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/);
    if (!m) {
      throw new Error(
        'Google Fonts の URL が指定されていません。次のように渡してください:\n' +
        '  node tools/fonts.mjs "$(node tools/font-url.mjs | tail -1)"'
      );
    }
    return m[1];
  })()).replace(/&amp;/g, '&');

const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();
const faces = [...css.matchAll(/\/\*\s*\[(\d+)\]\s*\*\/|@font-face\s*\{([^}]+)\}/g)]
  .map((x) => x[2]).filter(Boolean);
if (!faces.length) throw new Error('@font-face が取れませんでした');

mkdirSync(OUT, { recursive: true });
const out = [];
let n = 0;
for (const body of faces) {
  const family = /font-family:\s*'([^']+)'/.exec(body)[1];
  const weight = /font-weight:\s*(\d+)/.exec(body)[1];
  const style = (/font-style:\s*(\w+)/.exec(body) || [, 'normal'])[1];
  const src = /url\((https:\/\/[^)]+)\)/.exec(body)[1];

  const buf = Buffer.from(await (await fetch(src, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = `${slug}-${weight}${style === 'italic' ? 'i' : ''}.woff2`;
  writeFileSync(join(OUT, name), buf);
  console.log(`  assets/fonts/${name}  ${(buf.length / 1024).toFixed(1)}KB  (${family} ${weight})`);
  n += buf.length;

  out.push(
`@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;` +
`src:url(assets/fonts/${name}) format('woff2')}`
  );
}
console.log(`\n合計 ${(n / 1024).toFixed(1)}KB\n`);
console.log(out.join('\n'));

// ライセンス表示（OFL は著作権表示の同梱を求めている）
const notices = [
  'Inter Tight — Copyright (c) 2020 The Inter Project Authors (https://github.com/rsms/inter)',
  'Zen Kaku Gothic New — Copyright (c) 2020 The Zen Kaku Gothic New Project Authors (https://github.com/googlefonts/zen-kakugothic)',
  '',
  'いずれも SIL Open Font License, Version 1.1 のもとで配布されている。',
  'ライセンス全文: https://openfontlicense.org/',
  '',
  'このディレクトリの woff2 は、Google Fonts の text= サブセット機能で',
  'このサイトが使う文字だけに絞ったもの。node tools/fonts.mjs で再生成できる。'
].join('\n');
writeFileSync(join(OUT, 'OFL.txt'), notices + '\n', 'utf8');
console.log('\nassets/fonts/OFL.txt を書き出しました');
