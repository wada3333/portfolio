/**
 * 公開するファイルだけを _site/ に集める（許可リスト方式）
 * ---------------------------------------------------------------------------
 *   node tools/make-site.mjs [出力先 = _site]
 *
 * GitHub Actions（.github/workflows/pages.yml）と tools/check.mjs が同じものを使う。
 * 許可リストに書いたものだけをコピーするので、新しいファイルを足しても
 * ここに書かない限り公開されない。仕様書・docs/・tools/・OG画像の下地などは入らない。
 * 外部依存なし（Node だけで動く）。
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(ROOT, '_site');

/** [置き場所, ファイル名の条件]。条件が無ければ1ファイルそのもの */
const ALLOW = [
  { dir: '.', only: 'index.html' },
  { dir: 'assets', only: 'og.png' },
  { dir: 'assets', only: 'favicon.svg' },
  { dir: 'assets/js', match: /\.js$/ },
  { dir: 'assets/images', match: /\.webp$/ },
  { dir: 'assets/fonts', match: /\.woff2$/ },
  { dir: 'assets/fonts', only: 'OFL.txt' }
];

rmSync(OUT, { recursive: true, force: true });
const copied = [];
for (const rule of ALLOW) {
  const names = rule.only ? [rule.only] : readdirSync(join(ROOT, rule.dir)).filter((n) => rule.match.test(n));
  for (const name of names) {
    const rel = rule.dir === '.' ? name : `${rule.dir}/${name}`;
    mkdirSync(dirname(join(OUT, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(OUT, rel));
    copied.push(rel);
  }
}
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`公開するファイル ${copied.length} 個 -> ${OUT}`);
for (const rel of copied.sort()) console.log('  ' + rel);
