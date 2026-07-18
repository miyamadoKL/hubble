/**
 * 数値、所要時間、バイト数などを、画面表示用の読みやすい文字列へ整形する
 * ユーティリティ関数群を定義するファイル。クエリ結果や実行統計のような
 * 密度の高い「計器盤」的な表示（IBM Plex Mono フォントを使用）で、
 * 桁区切りなどの表記を統一するために使う。
 *
 * `date-fns` へは置き換えない。現行の各 helper 実装が小さく、ライブラリ導入は
 * 正味の削減にならない。
 */

// 3桁ごとにカンマ区切りを行うための Intl.NumberFormat インスタンス。
// 呼び出しごとに生成するとコストがかかるため、モジュールスコープで1つだけ生成し使い回す。
const numberGrouping = new Intl.NumberFormat('en-US');

/**
 * 整数を3桁区切り（カンマ区切り）の文字列に整形する。
 * 例: `1500000` → `"1,500,000"`
 * 小数を渡した場合は `Math.round` で四捨五入してから整形する。
 *
 * @param value 整形したい数値。
 * @returns カンマ区切りされた整数の文字列表現。
 */
export function formatInt(value: number): string {
  return numberGrouping.format(Math.round(value));
}

/**
 * 小数を、指定した桁数の固定小数点表記かつ3桁区切りの文字列に整形する。
 * 例: `173665.47` → `"173,665.47"`
 *
 * @param value 整形したい数値。
 * @param fractionDigits 小数点以下の桁数（デフォルトは2桁）。
 * @returns 3桁区切りと固定小数点桁数の文字列表現。
 */
export function formatDecimal(value: number, fractionDigits = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * バイト数を、人間が読みやすい単位（B/KB/MB/GB/TB）に変換した文字列に整形する。
 * 例: `28311552` → `"27.0 MB"`
 * 1024 バイト未満はそのまま「○ B」として返し、それ以外は 1024 で
 * 繰り返し割っていき、最も適切な単位（TB を上限）を選ぶ。
 *
 * @param bytes バイト数。
 * @returns 適切な単位に変換された文字列（小数点以下1桁）。
 */
export function formatBytes(bytes: number): string {
  // 1024 バイト未満はそのまま「B」単位で返す（小数点なし）。
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  // 値が1024以上ある限り、次の大きい単位へ繰り上げていく。
  // ただし units 配列の末尾（TB）を超えないようにガードする。
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // 最終的に選ばれた単位で、小数点以下1桁にフォーマットして返す。
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 経過時間（ミリ秒）を、コンパクトで読みやすい文字列に整形する。
 * 1秒未満は「○ ms」、60秒未満は「○ s」（10秒未満は小数点1桁まで表示）、
 * それ以上は「○m ○s」（分と秒の組み合わせ）で表す。
 * 例: `412` → `"412 ms"`, `8200` → `"8.2 s"`, `92000` → `"1m 32s"`
 *
 * @param ms 経過時間（ミリ秒）。
 * @returns 整形された経過時間の文字列。
 */
export function formatDuration(ms: number): string {
  // 1秒未満はミリ秒表記のまま返す。
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  // 60秒未満は秒表記。10秒未満は小数点以下1桁まで表示し、
  // 10秒以上は整数秒に丸めることで、短い時間ほど精度の高い表示にする。
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  // 60秒以上は「○分○秒」形式に変換する。秒は2桁ゼロ埋めで揃える。
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/**
 * ISO 形式の日時文字列を、現在時刻からの相対時間表記に整形する。
 * 実行履歴一覧などで「3分前」「2時間前」のような表示に使う。
 * 例: 直近1分未満は "just now"、1分〜59分は "○m ago"、
 * 1時間〜23時間は "○h ago"、それ以上は "○d ago"。
 *
 * @param iso 対象の日時を表す ISO 8601 形式の文字列。
 * @param now 比較基準となる現在時刻（テスト容易性のため引数で注入可能。デフォルトは `new Date()`）。
 * @returns 相対時間を表す文字列。`iso` が不正な日時の場合は空文字列。
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  // iso が不正な日時文字列でパースに失敗した場合、diffMs が NaN になるため
  // 空文字列を返して呼び出し側で表示崩れが起きないようにする。
  if (Number.isNaN(diffMs)) return '';
  const minutes = Math.round(diffMs / 60000);
  // 1分未満は「たった今」を意味する固定文言を返す。
  if (minutes < 1) return 'just now';
  // 60分未満は分単位で表示する。
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  // 24時間未満は時間単位で表示する。
  if (hours < 24) return `${hours}h ago`;
  // それ以上は日単位で表示する（上限のカット処理は行わない）。
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
