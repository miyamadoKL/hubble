// Part of the trino-lang module.
//
// `splitStatements` cuts a multi-statement source on top-level semicolons,
// using the ANTLR *lexer* so that semicolons inside string literals or comments
// are never treated as separators (the lexer already groups those into atomic
// STRING / *_COMMENT tokens; a bare `;` lexes as UNRECOGNIZED). Each returned
// segment carries its trimmed text plus the 0-based [start, end) character
// offsets into the original source — P3b/P4's gutter execution converts these
// to Monaco ranges. Empty/whitespace-only segments are dropped.

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from './generated/SqlBaseLexer.js';

export interface StatementSlice {
  /** Statement text with surrounding whitespace trimmed. */
  text: string;
  /** 0-based character offsets into the original source. `end` is exclusive. */
  start: number;
  end: number;
}

/** True when an UNRECOGNIZED token is a bare top-level `;` separator. */
function isSemicolon(token: Token): boolean {
  return token.type === SqlBaseLexer.UNRECOGNIZED && token.text === ';';
}

/**
 * Split `source` into statements on top-level semicolons (string/comment aware).
 * Returns one slice per non-empty statement, each with trimmed text and the
 * offsets of its *untrimmed* span in the source.
 */
export function splitStatements(source: string): StatementSlice[] {
  if (!source.trim()) return [];

  const lexer = new SqlBaseLexer(CharStream.fromString(source));
  lexer.removeErrorListeners();
  const tokenStream = new CommonTokenStream(lexer);
  tokenStream.fill();
  const tokens = tokenStream.getTokens();

  // Collect the source offsets of each top-level semicolon.
  const cutPoints: number[] = [];
  for (const token of tokens) {
    if (isSemicolon(token)) cutPoints.push(token.start);
  }

  const slices: StatementSlice[] = [];
  let segStart = 0;
  const boundaries = [...cutPoints, source.length];
  for (const boundary of boundaries) {
    // Segment is [segStart, boundary); the semicolon at `boundary` is dropped.
    const raw = source.slice(segStart, boundary);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const start = segStart + leading;
      slices.push({ text: trimmed, start, end: start + trimmed.length });
    }
    segStart = boundary + 1; // skip the semicolon char
  }

  return slices;
}
