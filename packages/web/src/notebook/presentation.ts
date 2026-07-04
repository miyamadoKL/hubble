// Presentation mode parsing. A notebook
// is flattened into read-only "cards", split on `--` comment headings so a SQL
// cell like
//
//   -- Revenue by segment
//   SELECT ...;
//   -- Top customers
//   SELECT ...
//
// renders as two titled cards. Pure + testable; the component renders the result.
//
// ==== ファイルの責務（日本語） ================================================
// プレゼンテーションモード向けの解析処理。notebook を
// 読み取り専用の「カード」の列に平坦化する。SQL セルは `--` コメント見出しで
// 区切られ、1 つのセル内に複数の見出しがあれば複数のカードに分割される。
// markdown セルはセル全体で 1 枚のカードになる。純粋関数のみで構成されており、
// 実際のレンダリングはコンポーネント側が担当する。
// ============================================================================

import type { Notebook } from '@hubble/contracts';

/** 1 枚のプレゼンテーションカード（見出し + 本文 + 由来するセル種別）。 */
export interface PresentationCard {
  /** Heading text from the `--` comment that opened the card, or null. */
  /** カードを開始した `--` コメントの見出しテキスト。見出しが無ければ null。 */
  title: string | null;
  /** The SQL/markdown body below the heading (trimmed; may be empty). */
  /** 見出しの下に続く SQL/markdown 本文（前後の空白は trim 済み。空の場合あり）。 */
  body: string;
  /** Source cell kind, so markdown cards can render differently. */
  /** 元のセル種別。markdown カードは SQL カードと異なる見た目で描画するために使う。 */
  kind: 'sql' | 'markdown';
}

/** A `--` line that is purely a comment heading (not trailing code). */
/**
 * 行全体が `--` コメントの見出しであるかを判定する（コードの末尾に付いた
 * コメントではなく、行頭からの純粋なコメント行のみを見出しとして扱う）。
 * 見出しでなければ null、見出しだが本文が空なら null（空見出しは無視）。
 */
function headingOf(line: string): string | null {
  const m = /^\s*--+\s?(.*)$/.exec(line);
  if (!m) return null;
  const text = m[1]!.trim();
  return text.length > 0 ? text : null;
}

/** Split one SQL cell's source into heading-delimited cards. */
/** 1 個の SQL セルのソースを、`--` 見出しで区切られた複数のカードに分割する。 */
function splitSqlCell(source: string): PresentationCard[] {
  const lines = source.split('\n');
  const cards: PresentationCard[] = [];
  let title: string | null = null;
  let buf: string[] = []; // 現在組み立て中のカードの本文行を溜めるバッファ。

  // それまで溜めていた title + buf を 1 枚のカードとして確定させる。
  // title も本文も空なら（何も無いので）カードを作らない。
  const flush = () => {
    const body = buf.join('\n').trim();
    if (title !== null || body.length > 0) cards.push({ title, body, kind: 'sql' });
    buf = [];
  };

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null) {
      // A heading starts a new card (flush the previous one first).
      // 見出し行を見つけたら、それまでのカードを確定させてから新しいカードを開始する。
      flush();
      title = heading;
    } else {
      buf.push(line);
    }
  }
  // ループ終了後、最後に組み立て中だったカードを確定させる。
  flush();
  return cards;
}

/**
 * Flatten a notebook into presentation cards. SQL cells are split on `--`
 * headings; markdown cells become a single card with the cell's name as title.
 * Empty cards are dropped.
 *
 * notebook 全体をプレゼンテーションカードの配列へ平坦化する。SQL セルは
 * `--` 見出しで分割され、markdown セルはセルの名前をタイトルとした 1 枚の
 * カードになる。中身が空のカードは結果から除外される。
 */
export function toPresentationCards(notebook: Notebook): PresentationCard[] {
  const cards: PresentationCard[] = [];
  for (const cell of notebook.cells) {
    if (cell.kind === 'markdown') {
      // markdown セルは分割せず、セル全体を 1 枚のカードにする。
      const body = cell.source.trim();
      if (body.length > 0) cards.push({ title: cell.name ?? null, body, kind: 'markdown' });
      continue;
    }
    // SQL セルは見出しで分割し、空でないカードだけを結果に加える。
    for (const card of splitSqlCell(cell.source)) {
      if (card.body.length > 0 || card.title) cards.push(card);
    }
  }
  return cards;
}
