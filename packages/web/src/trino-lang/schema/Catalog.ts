// schema/ 配下のメタデータモデルの最上位階層である「カタログ（Trino のコネクタ）」を
// 表すクラス。配下に複数の Schema を名前で保持する。カタログ単位のロード失敗を
// errorMessage として表現できる。

import Schema from './Schema';

/**
 * A catalog (connector) and the schemas discovered within it.
 *
 * カタログ（Trino のコネクタ）と、その中で発見されたスキーマ群を表す値オブジェクト。
 */
class Catalog {
  private name: string;
  private type: string;
  private errorMessage: string = '';
  private schemas: Map<string, Schema> = new Map<string, Schema>();

  constructor(name: string, type: string) {
    this.name = name;
    this.type = type;
  }

  getName(): string {
    return this.name;
  }

  getType(): string {
    return this.type;
  }

  // 既に同名のスキーマがあればそれを返し、なければ新規に登録してから返す
  // （get-or-insert）。呼び出し側は常に同一インスタンスを再利用できる。
  getOrAdd(schema: Schema): Schema {
    if (!this.schemas.has(schema.getName())) {
      this.schemas.set(schema.getName(), schema);
    }
    return this.schemas.get(schema.getName()) as Schema;
  }

  getSchemas(): Map<string, Schema> {
    return this.schemas;
  }

  setErrorMessage(error: string) {
    this.errorMessage = error;
  }

  clearErrorMessage() {
    this.errorMessage = '';
  }

  getError() {
    return this.errorMessage;
  }
}

export default Catalog;
