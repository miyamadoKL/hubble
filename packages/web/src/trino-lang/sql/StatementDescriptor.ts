// sql/ 配下（パース結果の走査 / スキーマキャッシュ層）の一部。SqlBaseListenerImpl が
// querySpecification（SELECT 文相当）を抜けるたびに 1 つ生成し、analyzer.ts の
// 補完処理（カーソル位置のクエリが参照しているテーブルの列を候補に出す）に使われる。

import type { Token } from 'antlr4ng';

/**
 * Records the primary table referenced by a query specification, with span.
 *
 * 1 つの querySpecification（SELECT 文相当）が主に参照しているテーブル名と、
 * その文がソース上で占める範囲（start/end トークン）を記録する。
 */
class StatementDescriptor {
  tableName: string;
  start: Token;
  end: Token;

  constructor(tableName: string, start: Token, stop: Token) {
    this.tableName = tableName;
    this.start = start;
    this.end = stop;
  }
}

export default StatementDescriptor;
