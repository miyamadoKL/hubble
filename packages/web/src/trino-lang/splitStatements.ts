// Part of the trino-lang module.
//
// `splitStatements` cuts a multi-statement source on top-level semicolons,
// using the ANTLR *lexer* so that semicolons inside string literals or comments
// are never treated as separators (the lexer already groups those into atomic
// STRING / *_COMMENT tokens; a bare `;` lexes as UNRECOGNIZED). Each returned
// segment carries its trimmed text plus the 0-based [start, end) character
// offsets into the original source — P3b/P4's gutter execution converts these
// to Monaco ranges. Empty/whitespace-only segments are dropped.
//
// ---- ファイル概要（日本語） ----
// 複数ステートメントからなる SQL ソースを、トップレベルのセミコロン `;` で
// ステートメント単位に分割するモジュール。文字列リテラルやコメントの中に
// セミコロンが含まれていても誤って区切り文字と判定しないよう、正規表現ではなく
// ANTLR の *レキサー* を使う（文字列/コメントはレキサーの時点で 1 つの STRING /
// *_COMMENT トークンとしてまとめられるため、それらの中にある `;` は分割対象に
// ならない。裸の `;` は UNRECOGNIZED トークンとしてレキシングされる）。各分割結果
// には前後の空白を除去したテキストに加え、元のソース文字列における 0 始まりの
// [start, end) オフセット（トリム前の範囲）を持たせる。これは executionGutter.ts
// （P3b/P4 のガター実行機能）が Monaco の範囲（行と列）に変換する際に使う。
// 空文字列/空白のみのセグメントは結果から除外される。

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from './generated/SqlBaseLexer.js';

/**
 * One statement extracted from a multi-statement source.
 *
 * 複数ステートメントのソースから抜き出した 1 つのステートメントを表す。
 */
export interface StatementSlice {
  /** Statement text with surrounding whitespace trimmed. */
  /** 前後の空白を取り除いたステートメントのテキスト。 */
  text: string;
  /** 0-based character offsets into the original source. `end` is exclusive. */
  /** 元のソース文字列における 0 始まりの文字オフセット。`end` は終端排他。 */
  start: number;
  end: number;
}

/** True when an UNRECOGNIZED token is a bare top-level `;` separator. */
/** トークンが「裸のトップレベル `;` 区切り文字」（UNRECOGNIZED として字句解析されたもの）かどうかを判定する。 */
function isSemicolon(token: Token): boolean {
  return token.type === SqlBaseLexer.UNRECOGNIZED && token.text === ';';
}

/**
 * Split `source` into statements on top-level semicolons (string/comment aware).
 * Returns one slice per non-empty statement, each with trimmed text and the
 * offsets of its *untrimmed* span in the source.
 *
 * `source` をトップレベルのセミコロンでステートメント単位に分割する（文字列/
 * コメント内のセミコロンは区切り文字として扱わない）。空でないステートメントごとに
 * 1 つの StatementSlice を返し、テキストはトリム済み、オフセットはトリム前の
 * （元のソース中の）範囲を指す。
 */
export function splitStatements(source: string): StatementSlice[] {
  // ソース全体が空白のみなら分割するまでもなく空配列を返す。
  if (!source.trim()) return [];

  // ANTLR レキサーだけを使い、パーサーは走らせない（分割にはトークン列だけで十分）。
  const lexer = new SqlBaseLexer(CharStream.fromString(source));
  lexer.removeErrorListeners();
  const tokenStream = new CommonTokenStream(lexer);
  tokenStream.fill();
  const tokens = tokenStream.getTokens();

  // Collect the source offsets of each top-level semicolon.
  // トップレベルのセミコロンそれぞれについて、ソース中の開始オフセットを集める。
  const cutPoints: number[] = [];
  for (const token of tokens) {
    if (isSemicolon(token)) cutPoints.push(token.start);
  }

  const slices: StatementSlice[] = [];
  let segStart = 0;
  // 最後のセグメント（末尾のセミコロン以降、あるいはセミコロンが 1 つもない場合は
  // ソース全体）も処理できるよう、ソース末尾の位置を境界リストの最後に追加する。
  const boundaries = [...cutPoints, source.length];
  for (const boundary of boundaries) {
    // Segment is [segStart, boundary); the semicolon at `boundary` is dropped.
    // 各セグメントは [segStart, boundary) の範囲（境界にあるセミコロン自体は含まない）。
    const raw = source.slice(segStart, boundary);
    // 先頭の空白量を数えておき、トリム後のテキストの実際の開始オフセットを求める。
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const start = segStart + leading;
      slices.push({ text: trimmed, start, end: start + trimmed.length });
    }
    segStart = boundary + 1; // skip the semicolon char
    // ↑ セミコロン自体の 1 文字をスキップして次のセグメントの開始位置とする。
  }

  return slices;
}
