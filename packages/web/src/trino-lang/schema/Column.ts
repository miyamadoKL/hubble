// schema/ 配下は カタログ → スキーマ → テーブル → カラム のメタデータモデルを表す。
// このファイルはその末端にあたる「カラム」を表すクラスを定義する。
// SchemaCache（sql/SchemaCache.ts）が MetadataSource から取得したメタデータを
// 変換してこの Column インスタンスを生成し、Table が保持する。

// Sample-value fetch is not implemented here; sampling flows through the DI'd
// MetadataSource / the contracts-based API client.
//
// サンプル値の取得はここでは実装しない。サンプリングは DI された MetadataSource /
// contracts ベースの API クライアントを経由して行われる。

/**
 * A single table column: declared type plus optional comment / extra info.
 *
 * 1 つのテーブルカラムを表す値オブジェクト。宣言された型に加えて、
 * コメントや付加情報（extra）を保持する。
 */
class Column {
  private name: string;
  private type: string;
  private extra: string;
  private comment: string;

  // name/type/extra/comment はいずれもメタデータソース側の値をそのまま保持するだけで、
  // 加工や正規化は行わない。
  constructor(name: string, type: string, extra: string, comment: string) {
    this.name = name;
    this.type = type;
    this.extra = extra;
    this.comment = comment;
  }

  getName() {
    return this.name;
  }

  getType() {
    return this.type;
  }

  getExtra() {
    return this.extra;
  }

  getComment() {
    return this.comment;
  }

  // extra（付加情報）があればそれを優先し、なければ comment にフォールバックする。
  // ホバー表示などで「一言説明」を出したいときに使う。
  getExtraOrComment() {
    return this.extra ? this.extra : this.comment;
  }
}

export default Column;
