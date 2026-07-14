/**
 * 生成された ANTLR token 定数の連続した範囲を Monaco のスコープへ変換する。
 *
 * 生成 lexer の定数だけを境界として参照し、個々の token を手動列挙しない。
 */
import { SqlBaseLexer } from '../generated/SqlBaseLexer.js';

export type TokenScope =
  | 'delimiter'
  | 'keyword'
  | 'operator'
  | 'string'
  | 'number'
  | 'identifier'
  | 'comment'
  | 'whitespace'
  | 'invalid';

/** ANTLR token 種別を Monaco のハイライトスコープへ変換する。 */
export function tokenScope(tokenType: number): TokenScope {
  if (tokenType >= SqlBaseLexer.T__0 && tokenType <= SqlBaseLexer.T__16) {
    return 'delimiter';
  }
  if (tokenType >= SqlBaseLexer.ABSENT && tokenType <= SqlBaseLexer.ZONE) {
    return tokenType === SqlBaseLexer.TEXT_STRING ? 'string' : 'keyword';
  }
  if (tokenType >= SqlBaseLexer.EQ && tokenType <= SqlBaseLexer.QUESTION_MARK) {
    return 'operator';
  }
  if (tokenType >= SqlBaseLexer.STRING && tokenType <= SqlBaseLexer.BINARY_LITERAL) {
    return 'string';
  }
  if (tokenType >= SqlBaseLexer.INTEGER_VALUE && tokenType <= SqlBaseLexer.DOUBLE_VALUE) {
    return 'number';
  }
  if (tokenType >= SqlBaseLexer.IDENTIFIER && tokenType <= SqlBaseLexer.BACKQUOTED_IDENTIFIER) {
    return 'identifier';
  }
  if (tokenType >= SqlBaseLexer.SIMPLE_COMMENT && tokenType <= SqlBaseLexer.BRACKETED_COMMENT) {
    return 'comment';
  }
  if (tokenType === SqlBaseLexer.WS) {
    return 'whitespace';
  }
  if (tokenType === SqlBaseLexer.UNRECOGNIZED) {
    return 'invalid';
  }
  return 'identifier';
}
