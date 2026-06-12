import { Fragment, useMemo } from 'react';
import { cn } from '../../utils/cn';

/**
 * Hand-written SQL token highlighter for the static code area (design.md §6:
 * "Monaco は P3a。今は pre+手書きトークン色で見た目だけ"). Produces themed spans
 * using token CSS variables — NO raw hex. This is presentation only; it is not a
 * real lexer and will be replaced by the Monaco/ANTLR pipeline in P3a.
 */

type TokenType = 'keyword' | 'function' | 'string' | 'number' | 'comment' | 'operator' | 'plain';

const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'join', 'left', 'right',
  'inner', 'outer', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'distinct',
  'limit', 'offset', 'union', 'all', 'case', 'when', 'then', 'else', 'end', 'with',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'view',
  'explain', 'asc', 'desc', 'between', 'like', 'exists', 'cross', 'using', 'date',
]);

const FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'round', 'coalesce', 'cast', 'date_trunc',
  'concat', 'lower', 'upper', 'abs', 'now', 'current_date', 'approx_distinct',
]);

const tokenColor: Record<TokenType, string> = {
  keyword: 'text-[var(--syntax-keyword)] font-medium',
  function: 'text-[var(--syntax-function)]',
  string: 'text-[var(--syntax-string)]',
  number: 'text-[var(--syntax-number)]',
  comment: 'text-[var(--syntax-comment)] italic',
  operator: 'text-[var(--syntax-operator)]',
  plain: 'text-[var(--syntax-plain)]',
};

interface Token {
  text: string;
  type: TokenType;
}

const TOKEN_RE = /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([(),.;*=<>!+\-/]+)|(\s+)/g;

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index), type: 'plain' });
    }
    const [full, comment, str, num, word, op, ws] = match;
    if (comment) tokens.push({ text: full, type: 'comment' });
    else if (str) tokens.push({ text: full, type: 'string' });
    else if (num) tokens.push({ text: full, type: 'number' });
    else if (word) {
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
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), type: 'plain' });
  return tokens;
}

interface SqlCodeProps {
  source: string;
  className?: string;
  /** Show a left gutter with line numbers (instrument density). */
  lineNumbers?: boolean;
}

export function SqlCode({ source, className, lineNumbers = true }: SqlCodeProps) {
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source]);
  return (
    <pre
      className={cn(
        'overflow-x-auto font-mono text-sm leading-relaxed text-[var(--syntax-plain)]',
        className,
      )}
    >
      <code className="grid" style={{ gridTemplateColumns: lineNumbers ? 'auto 1fr' : '1fr' }}>
        {lines.map((line, i) => (
          <Fragment key={i}>
            {lineNumbers && (
              <span
                aria-hidden
                className="pr-3 text-right text-2xs text-ink-subtle select-none tabular-nums"
              >
                {i + 1}
              </span>
            )}
            <span className="whitespace-pre">
              {line.length === 0 ? ' ' : null}
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
