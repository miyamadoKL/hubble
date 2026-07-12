/** production build の静的 asset と初期 preload を予算内に保つ。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url);
const MAX_TOTAL_BYTES = 9 * 1024 * 1024;
const MAX_FONT_BYTES = 1_280 * 1024;
const MAX_INITIAL_CSS_BYTES = 256 * 1024;
const FORBIDDEN_PRELOADS = ['monaco', 'echarts', 'antlr', 'trino-grammar', 'formatter'];

const files = collectFiles(DIST.pathname);
const totalBytes = sumBytes(files);
const fontFiles = files.filter((path) => /\.(?:woff2?|ttf)$/i.test(path));
const fontBytes = sumBytes(fontFiles);
const cssFiles = files.filter((path) => path.endsWith('.css'));
const cssBytes = sumBytes(cssFiles);
const legacyWoff = fontFiles.filter((path) => path.endsWith('.woff'));
const indexHtml = readFileSync(join(DIST.pathname, 'index.html'), 'utf8');
const forbiddenPreloads = FORBIDDEN_PRELOADS.filter((name) =>
  new RegExp(`<link[^>]+modulepreload[^>]+${name}`, 'i').test(indexHtml),
);

const violations = [];
if (totalBytes > MAX_TOTAL_BYTES) {
  violations.push(`asset total ${totalBytes} exceeds ${MAX_TOTAL_BYTES} bytes`);
}
if (fontBytes > MAX_FONT_BYTES) {
  violations.push(`font total ${fontBytes} exceeds ${MAX_FONT_BYTES} bytes`);
}
if (cssBytes > MAX_INITIAL_CSS_BYTES) {
  violations.push(`CSS total ${cssBytes} exceeds ${MAX_INITIAL_CSS_BYTES} bytes`);
}
if (legacyWoff.length > 0) {
  violations.push(`legacy WOFF assets were emitted: ${legacyWoff.map(displayPath).join(', ')}`);
}
if (forbiddenPreloads.length > 0) {
  violations.push(`heavy chunks were modulepreloaded: ${forbiddenPreloads.join(', ')}`);
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`bundle budget: ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `bundle budget: total=${totalBytes} fonts=${fontBytes} css=${cssBytes} heavyPreloads=0`,
  );
}

/** 指定ディレクトリ以下の通常ファイルを再帰的に列挙する。 */
function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

/** ファイル配列の合計 byte 数を返す。 */
function sumBytes(paths) {
  return paths.reduce((total, path) => total + statSync(path).size, 0);
}

/** エラーメッセージ用に dist からの相対パスへ変換する。 */
function displayPath(path) {
  return relative(DIST.pathname, path);
}
