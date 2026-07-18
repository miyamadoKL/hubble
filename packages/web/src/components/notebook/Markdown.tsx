/**
 * Markdown.tsx
 *
 * Notebook の Markdown セル本文と Presentation モードのスライド本文を描画する、
 * 外部ライブラリに依存しない軽量 Markdown レンダラー。画面上では
 * MarkdownCell（セルのプレビュー表示）と PresentationView（読み取り専用の
 * スライドカード）の双方から呼び出される、純粋な表示コンポーネント。
 *
 * 対応する記法は見出し（h1〜h3）、太字/斜体/インラインコード、番号無し/番号付き
 * リスト、引用、フェンスコードブロック、GitHub 風テーブルに限られる（リンク、
 * オートリンク、取り消し線、タスクリストは非対応）。
 *
 * react-markdown と remark-gfm への置換は見送っている。2026 年 7 月 15 日の PoC で
 * 4 件の characterization test を固定した上で評価したところ、最小構成でも本ファイルは
 * 306 行から 141 行までしか減らず、削減量 165 行は採用基準の 190 行を下回った。加えて
 * inline code の class、task list の literal 表示、escape と壊れた inline 入力の処理が
 * 現行動作と一致せず、4 fixture 中 3 fixture が失敗した（依存追加も 96 package、
 * lockfile 869 行増）。互換 adapter を足すとさらに削減が悪化するため、対応記法を
 * CommonMark/GFM へ拡張する製品判断がない限りこの自前パーサーを維持する。
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

// ---- インライン span の解析 ---------------------------------------------------

// テキスト中のインライン装飾（`code` / **bold** / *italic* / _italic_）を正規表現で
// 分割し、対応する React ノード（code / strong / em / 素のテキスト）へ変換する。
// 見出し、リスト項目、テーブルセルなど複数の呼び出し元から再利用される。
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 分割順が重要: まずインラインコードを切り出す（コード内の `**` を装飾と誤認しないため）。
  // その後に太字、最後に斜体を判定する。
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

// ---- ブロックの解析 -----------------------------------------------------------

// ソース文字列を1行ずつ走査してブロック単位（コード/テーブル/見出し/リスト/引用/段落）
// に分類するための内部表現。type タグで判別する判別共用体になっている。
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

// 行頭と行末の `|` を取り除いてから `|` で分割し、各セルの前後空白を落とす。
function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

// GitHub 風テーブルの区切り行（例: `---|:--:|---`）を検出する正規表現。
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;
const isTableRow = (line: string): boolean => /\|/.test(line);

/**
 * Markdown ソース全体を行単位で走査し、Block の配列へ変換する。
 * フェンスコード、テーブル、リスト、見出し、引用、段落を判定しながら順に積み上げる。
 */
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  // 直前から続いているリスト項目を溜めておくバッファ（ブロック種別が変わったら flush する）。
  let ul: string[] = [];
  let ol: string[] = [];

  // 溜まっている ul/ol バッファを確定済みブロックとして blocks に押し出す。
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

    // フェンスコードブロック（```lang … ```）の開始行。閉じフェンスが見つかるまで本文行をそのまま収集する。
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

    // GitHub 風テーブル（ヘッダ行の次に `---|---` の区切り行が続く形）の開始判定。
    // 現在行がヘッダ行で、次の行が区切り行ならテーブルの開始とみなす。
    if (isTableRow(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flushLists();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2; // ヘッダ行と区切り行の分をスキップする
      while (i < lines.length && isTableRow(lines[i]!) && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      i--; // 1 つ戻す（for ループが再度インクリメントするため）
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // 番号無しリスト項目（-, *）。
    if (/^\s*[-*]\s+/.test(line)) {
      if (ol.length) flushLists();
      ul.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    // 番号付きリスト項目（1. 2. …）。
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

// ---- 描画 -----------------------------------------------------------------------

/**
 * Markdown ソース文字列をレンダリングするプレゼンテーションコンポーネント。
 *
 * @param source - 描画対象の Markdown 文字列（MarkdownCell や PresentationView が渡す）。
 * @param className - ルート div に追加する Tailwind クラス（呼び出し側でのレイアウト調整用）。
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  // 描画のたびにソースを再パースする（ブロック数が小さいノート用途では十分軽量）。
  const blocks = parseBlocks(source);
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed text-ink-base', className)}>
      {blocks.map((block, i) => {
        // ブロック種別ごとに対応する HTML 要素へマッピングする。
        switch (block.type) {
          // 見出し h1〜h3: 1行分のテキストを renderInline でインライン装飾しつつ描画。
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
          // 箇条書きリスト（-, * ）: 各項目をドットアイコン付きの li として描画。
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
          // 番号付きリスト（1. 2. …）: 項目ごとに連番（j + 1）を左側に表示する。
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
          // 引用ブロック（先頭が `> `）: 左ボーダー付きの blockquote として描画。
          case 'quote':
            return (
              <blockquote
                key={i}
                className="border-l-2 border-accent/40 bg-surface-sunken py-2 pl-3 text-ink-muted"
              >
                {renderInline(block.lines[0] ?? '', `q-${i}`)}
              </blockquote>
            );
          // フェンスコードブロック（``` … ```）: インライン装飾は適用せず、行をそのまま連結して表示する
          // （renderInline を通さないため、コード内の `*` などが誤って装飾されることはない）。
          case 'code':
            return (
              <pre
                key={i}
                className="overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-3 py-2"
              >
                <code className="font-mono text-xs text-ink-base">{block.lines.join('\n')}</code>
              </pre>
            );
          // GitHub 風テーブル: header 行を thead に、rows を tbody に展開して描画する。
          case 'table':
            return (
              <div key={i} className="overflow-auto rounded-md border border-border-subtle">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-surface-sunken">
                      {/* ヘッダーセル群。各セルの中身もインライン装飾（**bold** 等）を適用する。 */}
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
                    {/* データ行群。各セルもインライン装飾を適用して描画する。 */}
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
          // 上記のいずれにも該当しない場合（通常の段落 'p'）は <p> として描画する。
          default:
            return <p key={i}>{renderInline(block.lines[0] ?? '', `p-${i}`)}</p>;
        }
      })}
    </div>
  );
}
