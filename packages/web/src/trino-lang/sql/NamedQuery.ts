import type { ParserRuleContext } from 'antlr4ng';

/** A named, referenceable relation: a CTE or an aliased subquery/relation. */
class NamedQuery {
  public name: string;
  public node: ParserRuleContext;

  constructor(name: string, node: ParserRuleContext) {
    this.name = name;
    this.node = node;
  }
}

export default NamedQuery;
