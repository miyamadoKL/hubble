// Sample-value fetch is not implemented here; sampling flows through the DI'd
// MetadataSource / the contracts-based API client.

/** A single table column: declared type plus optional comment / extra info. */
class Column {
  private name: string;
  private type: string;
  private extra: string;
  private comment: string;

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

  getExtraOrComment() {
    return this.extra ? this.extra : this.comment;
  }
}

export default Column;
