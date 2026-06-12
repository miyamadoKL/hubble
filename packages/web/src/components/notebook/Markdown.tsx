import { Fragment, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * Lightweight markdown renderer for markdown-cell previews (design.md §6).
 * Covers the subset a SQL notebook needs: headings (h1–h3), bold / italic /
 * inline code, ordered + unordered lists, blockquotes, fenced code blocks and
 * GitHub-style tables. Deliberately dependency-free (no markdown-it) — the
 * grammar here is small and predictable for notebook notes.
 */

// ---- Inline spans -----------------------------------------------------------

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: inline code first (so `**` inside code stays literal), then
  // bold (`**`), then italic (`*` / `_`).
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
  const parts = text.split(regex);
  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-xs text-accent"
        >
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink-strong">
          {part.slice(2, -2)}
        </strong>,
      );
    } else if (
      (part.startsWith('*') && part.endsWith('*')) ||
      (part.startsWith('_') && part.endsWith('_'))
    ) {
      nodes.push(
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>,
      );
    } else {
      nodes.push(<Fragment key={key}>{part}</Fragment>);
    }
  });
  return nodes;
}

// ---- Block parsing ----------------------------------------------------------

interface CodeBlock {
  type: 'code';
  lang?: string;
  lines: string[];
}
interface TableBlock {
  type: 'table';
  header: string[];
  rows: string[][];
}
interface TextBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote';
  lines: string[];
}
type Block = CodeBlock | TableBlock | TextBlock;

/** Split a `| a | b |` row into trimmed cells. */
function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;
const isTableRow = (line: string): boolean => /\|/.test(line);

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  let ul: string[] = [];
  let ol: string[] = [];

  const flushLists = () => {
    if (ul.length) {
      blocks.push({ type: 'ul', lines: ul });
      ul = [];
    }
    if (ol.length) {
      blocks.push({ type: 'ol', lines: ol });
      ol = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code block: ```lang … ```
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushLists();
      const lang = fence[1]!.trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ type: 'code', lang, lines: body });
      continue;
    }

    // GitHub table: a header row followed by a `---|---` divider.
    if (isTableRow(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flushLists();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2; // skip header + divider
      while (i < lines.length && isTableRow(lines[i]!) && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      i--; // step back; the for-loop will advance
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Unordered list item.
    if (/^\s*[-*]\s+/.test(line)) {
      if (ol.length) flushLists();
      ul.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    // Ordered list item.
    if (/^\s*\d+\.\s+/.test(line)) {
      if (ul.length) flushLists();
      ol.push(line.replace(/^\s*\d+\.\s+/, ''));
      continue;
    }

    flushLists();
    if (line.trim() === '') continue;
    if (line.startsWith('### ')) blocks.push({ type: 'h3', lines: [line.slice(4)] });
    else if (line.startsWith('## ')) blocks.push({ type: 'h2', lines: [line.slice(3)] });
    else if (line.startsWith('# ')) blocks.push({ type: 'h1', lines: [line.slice(2)] });
    else if (line.startsWith('> ')) blocks.push({ type: 'quote', lines: [line.slice(2)] });
    else blocks.push({ type: 'p', lines: [line] });
  }
  flushLists();
  return blocks;
}

// ---- Render -----------------------------------------------------------------

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed text-ink-base', className)}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'h1':
            return (
              <h1 key={i} className="text-xl font-semibold text-ink-strong">
                {renderInline(block.lines[0] ?? '', `h1-${i}`)}
              </h1>
            );
          case 'h2':
            return (
              <h2 key={i} className="text-lg font-semibold text-ink-strong">
                {renderInline(block.lines[0] ?? '', `h2-${i}`)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={i} className="text-base font-semibold text-ink-strong">
                {renderInline(block.lines[0] ?? '', `h3-${i}`)}
              </h3>
            );
          case 'ul':
            return (
              <ul key={i} className="ml-1 space-y-1">
                {block.lines.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                    <span>{renderInline(item, `li-${i}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="ml-1 space-y-1">
                {block.lines.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="shrink-0 font-mono text-xs text-accent tabular-nums">
                      {j + 1}.
                    </span>
                    <span>{renderInline(item, `oli-${i}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote
                key={i}
                className="border-l-2 border-accent/40 bg-surface-sunken py-2 pl-3 text-ink-muted"
              >
                {renderInline(block.lines[0] ?? '', `q-${i}`)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={i}
                className="overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-3 py-2"
              >
                <code className="font-mono text-xs text-ink-base">{block.lines.join('\n')}</code>
              </pre>
            );
          case 'table':
            return (
              <div key={i} className="overflow-auto rounded-md border border-border-subtle">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-surface-sunken">
                      {block.header.map((h, hi) => (
                        <th
                          key={hi}
                          className="border-b border-border-subtle px-2.5 py-1.5 text-left font-semibold text-ink-strong"
                        >
                          {renderInline(h, `th-${i}-${hi}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border-subtle last:border-0">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2.5 py-1.5 align-top">
                            {renderInline(cell, `td-${i}-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={i}>{renderInline(block.lines[0] ?? '', `p-${i}`)}</p>;
        }
      })}
    </div>
  );
}
