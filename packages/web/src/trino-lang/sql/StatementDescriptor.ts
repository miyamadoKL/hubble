// Forked from trino-query-ui (Apache-2.0). See repo-root NOTICE.
// Adapted: typed start/end (were `any`).

import type { Token } from 'antlr4ng';

/** Records the primary table referenced by a query specification, with span. */
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
