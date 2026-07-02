// sql/ 配下はパース結果（ANTLR パースツリー）の走査とスキーマキャッシュを扱う層。
// このファイルは SqlBaseListenerImpl がパースツリー走査中に見つけた
// 「名前を持つリレーション（CTE またはエイリアス付きリレーション）」を表す。
// analyzer.ts の補完処理が、FROM 句の後で CTE 名を候補として出すために参照する。

import type { ParserRuleContext } from 'antlr4ng';

/**
 * A named, referenceable relation: a CTE or an aliased subquery/relation.
 *
 * 名前で参照可能なリレーション（CTE、またはエイリアス付きのサブクエリ/リレーション）を
 * 表す値オブジェクト。対応するパースツリーのノードも保持する。
 */
class NamedQuery {
  public name: string;
  public node: ParserRuleContext;

  constructor(name: string, node: ParserRuleContext) {
    this.name = name;
    this.node = node;
  }
}

export default NamedQuery;
