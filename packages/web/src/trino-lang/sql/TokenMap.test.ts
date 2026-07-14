import { CharStream } from 'antlr4ng';
import { describe, expect, it } from 'vitest';
import { SqlBaseLexer } from '../generated/SqlBaseLexer.js';
import { tokenScope, type TokenScope } from './TokenMap';

type TokenView = {
  text: string;
  scope: TokenScope;
};

const SCOPE_CODES: Record<TokenScope, string> = {
  delimiter: 'd',
  keyword: 'k',
  operator: 'o',
  string: 's',
  number: 'n',
  identifier: 'i',
  comment: 'c',
  whitespace: 'w',
  invalid: 'x',
};

const EXPECTED_SCOPE_CODES =
  'dddddddddddddddddkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkskkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkooooooooooooosssnnniiiiccwx';

function lex(sql: string): TokenView[] {
  const lexer = new SqlBaseLexer(CharStream.fromString(sql));
  const tokens: TokenView[] = [];
  for (let token = lexer.nextToken(); token.type !== SqlBaseLexer.EOF; token = lexer.nextToken()) {
    tokens.push({
      text: token.text ?? '',
      scope: tokenScope(token.type),
    });
  }
  return tokens;
}

describe('tokenScope', () => {
  it.each([
    [SqlBaseLexer.T__0, 'delimiter'],
    [SqlBaseLexer.T__16, 'delimiter'],
    [SqlBaseLexer.ABSENT, 'keyword'],
    [SqlBaseLexer.TEXT_STRING, 'string'],
    [SqlBaseLexer.ZONE, 'keyword'],
    [SqlBaseLexer.EQ, 'operator'],
    [SqlBaseLexer.QUESTION_MARK, 'operator'],
    [SqlBaseLexer.STRING, 'string'],
    [SqlBaseLexer.BINARY_LITERAL, 'string'],
    [SqlBaseLexer.INTEGER_VALUE, 'number'],
    [SqlBaseLexer.DOUBLE_VALUE, 'number'],
    [SqlBaseLexer.IDENTIFIER, 'identifier'],
    [SqlBaseLexer.BACKQUOTED_IDENTIFIER, 'identifier'],
    [SqlBaseLexer.SIMPLE_COMMENT, 'comment'],
    [SqlBaseLexer.BRACKETED_COMMENT, 'comment'],
    [SqlBaseLexer.WS, 'whitespace'],
    [SqlBaseLexer.UNRECOGNIZED, 'invalid'],
  ] as const)('classifies the %s boundary as %s', (tokenType, scope) => {
    expect(tokenScope(tokenType)).toBe(scope);
  });

  it.each([0, -1, SqlBaseLexer.UNRECOGNIZED + 1, Number.MAX_SAFE_INTEGER])(
    'falls back to identifier for unknown token type %s',
    (tokenType) => {
      expect(tokenScope(tokenType)).toBe('identifier');
    },
  );

  it('keeps every generated token type aligned with the independent golden', () => {
    expect(SqlBaseLexer.T__0).toBe(1);
    expect(SqlBaseLexer.UNRECOGNIZED).toBe(322);

    const scopes = Array.from({ length: 322 }, (_, index) => tokenScope(index + 1));
    const actualScopeCodes = scopes.map((scope) => SCOPE_CODES[scope]).join('');
    const scopeCounts: Record<TokenScope, number> = {
      delimiter: 0,
      keyword: 0,
      operator: 0,
      string: 0,
      number: 0,
      identifier: 0,
      comment: 0,
      whitespace: 0,
      invalid: 0,
    };
    for (const scope of scopes) {
      scopeCounts[scope] += 1;
    }

    expect(actualScopeCodes).toBe(EXPECTED_SCOPE_CODES);
    expect(scopeCounts).toEqual({
      delimiter: 17,
      keyword: 277,
      operator: 13,
      string: 4,
      number: 3,
      identifier: 4,
      comment: 2,
      whitespace: 1,
      invalid: 1,
    });
  });

  it('classifies representative output from the real Trino lexer', () => {
    const tokens = lex('SELECT foo = \'bar\' + 42, "quoted" /* block */ -- line\n@');

    expect(tokens.map(({ text, scope }) => ({ scope, text }))).toEqual([
      { scope: 'keyword', text: 'SELECT' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'identifier', text: 'foo' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'operator', text: '=' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'string', text: "'bar'" },
      { scope: 'whitespace', text: ' ' },
      { scope: 'operator', text: '+' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'number', text: '42' },
      { scope: 'delimiter', text: ',' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'identifier', text: '"quoted"' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'comment', text: '/* block */' },
      { scope: 'whitespace', text: ' ' },
      { scope: 'comment', text: '-- line\n' },
      { scope: 'invalid', text: '@' },
    ]);
  });
});
