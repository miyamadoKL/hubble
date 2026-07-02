/**
 * SqlCode.tsx
 *
 * SQL コードを静的に表示するための、簡易的な自前シンタックスハイライトコンポーネント。
 * 正規表現ベースのトークナイザで SQL 文字列をキーワード/関数/文字列/数値/コメント/
 * 演算子/その他に分類し、それぞれをテーマ用の CSS 変数（--syntax-*）を使った
 * 色付きの <span> として描画する。あくまで見た目だけの簡易実装であり、
 * 本格的な字句解析器ではない（将来的に Monaco/ANTLR ベースの実装に置き換え予定）。
 */
import { Fragment, useMemo } from 'react';
import { cn } from '../../utils/cn';

/**
 * Hand-written SQL token highlighter for the static code area (design.md §6:
 * "Monaco は P3a。今は pre+手書きトークン色で見た目だけ"). Produces themed spans
 * using token CSS variables — NO raw hex. This is presentation only; it is not a
 * real lexer and will be replaced by the Monaco/ANTLR pipeline in P3a.
 */

// トークンの種別。色付けのバリエーションに対応する。
type TokenType = 'keyword' | 'function' | 'string' | 'number' | 'comment' | 'operator' | 'plain';

// SQL の予約語として強調表示する単語の集合（小文字で比較する）。
const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'join', 'left', 'right',
  'inner', 'outer', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'distinct',
  'limit', 'offset', 'union', 'all', 'case', 'when', 'then', 'else', 'end', 'with',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'view',
  'explain', 'asc', 'desc', 'between', 'like', 'exists', 'cross', 'using', 'date',
]);

// 関数名として強調表示する単語の集合（小文字で比較する）。
const FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'round', 'coalesce', 'cast', 'date_trunc',
  'concat', 'lower', 'upper', 'abs', 'now', 'current_date', 'approx_distinct',
]);

// トークン種別ごとの表示クラス。すべてテーマ用の CSS 変数（--syntax-*）経由で色を参照し、
// 生の16進カラーコードは使わない（テーマ切り替えに追従させるため）。
const tokenColor: Record<TokenType, string> = {
  keyword: 'text-[var(--syntax-keyword)] font-medium',
  function: 'text-[var(--syntax-function)]',
  string: 'text-[var(--syntax-string)]',
  number: 'text-[var(--syntax-number)]',
  comment: 'text-[var(--syntax-comment)] italic',
  operator: 'text-[var(--syntax-operator)]',
  plain: 'text-[var(--syntax-plain)]',
};

/** トークナイズされた1単位。表示テキストと種別（色付けの区分）を持つ。 */
interface Token {
  text: string;
  type: TokenType;
}

// SQL の1行を走査するための正規表現。以下の優先順でキャプチャグループを持つ:
// 1. `--` 行末までのコメント
// 2. シングルクォート文字列（バックスラッシュエスケープ対応）
// 3. 数値リテラル（整数、小数）
// 4. 識別子/予約語/関数名になりうる単語
// 5. 記号列（カンマ、括弧、比較演算子、算術演算子など）
// 6. 空白列
const TOKEN_RE = /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([(),.;*=<>!+\-/]+)|(\s+)/g;

/**
 * 1行分の SQL テキストを TOKEN_RE でスキャンし、Token の配列へ分解する。
 * マッチしなかった隙間（未対応の記号など）は 'plain' 種別としてそのまま拾う。
 * 単語トークンについては KEYWORDS / FUNCTIONS の集合と照合し、
 * キーワード、関数名、それ以外（識別子など）のいずれかに分類する。
 */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  // グローバルフラグ付き正規表現なので、呼び出しごとに lastIndex をリセットしておく。
  TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    // 直前のマッチ位置と今回のマッチ開始位置の間に隙間があれば、それも 'plain' として拾っておく。
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index), type: 'plain' });
    }
    const [full, comment, str, num, word, op, ws] = match;
    if (comment) tokens.push({ text: full, type: 'comment' });
    else if (str) tokens.push({ text: full, type: 'string' });
    else if (num) tokens.push({ text: full, type: 'number' });
    else if (word) {
      // 単語トークンは小文字化して KEYWORDS → FUNCTIONS の順に照合し、
      // どちらにも該当しなければ通常の識別子として 'plain' 扱いにする。
      const lower = word.toLowerCase();
      const type: TokenType = KEYWORDS.has(lower)
        ? 'keyword'
        : FUNCTIONS.has(lower)
          ? 'function'
          : 'plain';
      tokens.push({ text: full, type });
    } else if (op) tokens.push({ text: full, type: 'operator' });
    else if (ws) tokens.push({ text: full, type: 'plain' });
    lastIndex = match.index + full.length;
  }
  // 最後のマッチ以降に残った末尾の文字列があれば、それも 'plain' として拾っておく。
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), type: 'plain' });
  return tokens;
}

/** SqlCode コンポーネントの props。 */
interface SqlCodeProps {
  /** ハイライト表示する SQL ソース文字列。 */
  source: string;
  /** ルート要素（pre）に追加する Tailwind クラス。 */
  className?: string;
  /** Show a left gutter with line numbers (instrument density). */
  /** 左側に行番号のガター（余白列）を表示するかどうか。デフォルトは true。 */
  lineNumbers?: boolean;
}

/**
 * SQL テキストを行ごとにトークナイズし、シンタックスハイライト付きで表示するコンポーネント。
 * `<pre><code>` の中を CSS Grid で「行番号列 + コード列」に分け、各行を tokenize() の結果に
 * 応じて色分けした <span> の並びとして描画する。
 */
export function SqlCode({ source, className, lineNumbers = true }: SqlCodeProps) {
  // ソース末尾の改行を1つだけ除去してから行配列に分割する（末尾に空行が余計に生まれないように）。
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source]);
  return (
    <pre
      className={cn(
        'overflow-x-auto font-mono text-sm leading-relaxed text-[var(--syntax-plain)]',
        className,
      )}
    >
      {/* lineNumbers の有無で grid-template-columns を切り替える（行番号列 auto + コード列 1fr、もしくはコード列のみ）。 */}
      <code className="grid" style={{ gridTemplateColumns: lineNumbers ? 'auto 1fr' : '1fr' }}>
        {/* 1行ずつ Fragment として描画: 行番号セル（任意）＋ トークン化されたコードセル。 */}
        {lines.map((line, i) => (
          <Fragment key={i}>
            {/* 行番号ガター。lineNumbers が true のときだけ表示する（1始まりの行番号）。 */}
            {lineNumbers && (
              <span
                aria-hidden
                className="pr-3 text-right text-2xs text-ink-subtle select-none tabular-nums"
              >
                {i + 1}
              </span>
            )}
            <span className="whitespace-pre">
              {/* 空行のままだと高さが潰れるため、幅を持つ空白文字を1つ差し込んで行の高さを確保する。 */}
              {line.length === 0 ? ' ' : null}
              {/* 行をトークン列へ分解し、それぞれ種別に応じた色クラスを当てた span として描画する。 */}
              {tokenize(line).map((token, j) => (
                <span key={j} className={tokenColor[token.type]}>
                  {token.text}
                </span>
              ))}
            </span>
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
