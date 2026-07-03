/**
 * Minimal CIDR membership test for the trusted-proxy boundary (design.md §11).
 *
 * Supports IPv4 and IPv6 ranges. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`,
 * which is how Node reports an IPv4 peer on a dual-stack socket) is matched
 * against both IPv4 and IPv6 ranges by normalizing it to its embedded IPv4. The
 * loopback addresses `127.0.0.0/8` (v4) and `::1/128` (v6) are the defaults.
 *
 * Implemented with BigInt bit math (v4 = 32-bit, v6 = 128-bit) — no dependency.
 *
 * 【このファイルの役割】
 * oauth2-proxy などの「信頼できるリバースプロキシ」からリクエストが来ているかを判定するための、
 * 最小限の CIDR（Classless Inter-Domain Routing）所属判定ロジック。
 * auth/principal.ts の PrincipalResolver がこのモジュールを使い、リクエストの送信元アドレスが
 * 信頼済みプロキシのアドレス帯に含まれる場合にのみ SSO ヘッダー（X-Forwarded-User 等）を信用する。
 * IPv4 / IPv6 双方に対応し、Node がデュアルスタックソケット上で IPv4 ピアを報告する際に使う
 * IPv4-mapped IPv6 アドレス（`::ffff:a.b.c.d`）は埋め込み IPv4 に正規化して比較する。
 * 外部ライブラリに依存せず、BigInt によるビット演算（v4=32bit, v6=128bit）のみで実装している。
 */

/** パース済みの CIDR レンジ。ベースアドレスとプレフィックス長を BigInt/number で保持する。 */
export interface ParsedCidr {
  /**
   * 4 for an IPv4 range, 6 for an IPv6 range.
   * IPv4 レンジなら 4、IPv6 レンジなら 6。
   */
  version: 4 | 6;
  /**
   * Network base address as a BigInt.
   * ネットワークベースアドレス（後述のプレフィックスマスクを適用済みの値）。
   */
  base: bigint;
  /**
   * Prefix length in bits (0–32 for v4, 0–128 for v6).
   * プレフィックス長（ビット数）。v4 は 0〜32、v6 は 0〜128。
   */
  prefix: number;
}

// アドレス長（ビット数）。シフト量の計算に使うため BigInt で持つ。
const V4_BITS = 32n;
const V6_BITS = 128n;

/**
 * Parse a dotted-quad IPv4 string into a 32-bit BigInt, or undefined.
 *
 * ドット区切り 4 組（例: "10.0.0.5"）の IPv4 文字列を 32bit の BigInt に変換する。
 * @param ip - パース対象の IPv4 文字列。
 * @returns 各オクテットを詰め込んだ BigInt。形式が不正（オクテット数不足、範囲外の数値、非数字）
 *          な場合は undefined。
 */
export function parseIpv4(ip: string): bigint | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined; // オクテットがちょうど4つでなければ不正
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined; // 数字1〜3桁以外は不正
    const octet = Number(part);
    if (octet > 255) return undefined; // オクテットは 0-255 の範囲
    // 8bit ずつ左シフトしながら OR で連結し、32bit の値を組み立てる。
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/**
 * Parse an IPv6 string into a 128-bit BigInt, or undefined. Handles `::`
 * compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 *
 * IPv6 文字列を 128bit の BigInt に変換する。`::` による省略記法や、末尾に埋め込まれた
 * IPv4（`::ffff:1.2.3.4` 形式）にも対応する。
 * @param ip - パース対象の IPv6 文字列（コロン区切り）。
 * @returns 8 個の 16bit グループを連結した 128bit の BigInt。形式が不正なら undefined。
 */
export function parseIpv6(ip: string): bigint | undefined {
  if (!ip.includes(':')) return undefined; // コロンを含まなければ IPv6 ではない
  // Reject more than one `::`.
  // `::` は1箇所にしか出現できない（複数あると省略範囲が一意に定まらない）ため split して確認する。
  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return undefined;

  // 空文字列（先頭/末尾が `::` の場合）は空配列に、それ以外は ':' 区切りでグループ配列にする。
  const expand = (segment: string): string[] => (segment === '' ? [] : segment.split(':'));

  let groups: string[];
  if (doubleColon.length === 2) {
    // `::` の前後をそれぞれ展開し、省略された分だけ '0' グループで埋めて合計8グループにする。
    const head = expand(doubleColon[0]!);
    const tail = expand(doubleColon[1]!);
    const fill = 8 - (head.length + tail.length);
    if (fill < 0) return undefined; // 前後だけで8グループを超える場合は不正
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    // `::` を含まない完全展開形式。そのままコロンで分割する。
    groups = ip.split(':');
  }
  if (groups.length !== 8) return undefined; // IPv6 は必ず8グループ

  let value = 0n;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    // A trailing IPv4 may occupy the final two 16-bit groups.
    // 最終グループがドットを含む場合、末尾の IPv4 埋め込み表記（例: ::ffff:127.0.0.1）とみなす。
    if (i === 7 && group.includes('.')) {
      const v4 = parseIpv4(group);
      if (v4 === undefined) return undefined;
      // The IPv4 fills groups 6 and 7; back out the placeholder we just added.
      // 32bit の IPv4 値を上位16bitと下位16bitに分割し、それぞれを16bitグループとして詰める
      // （末尾の2グループ分＝32bitを埋め込み IPv4 で置き換える）。
      value = (value << 16n) | (v4 >> 16n);
      value = (value << 16n) | (v4 & 0xffffn);
      return value & ((1n << V6_BITS) - 1n); // 128bit に収まるようマスクして返す
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined; // 16進数1〜4桁以外は不正
    // 16bit グループを左シフトしながら詰め込み、128bit の値を組み立てる。
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

// IPv4-mapped IPv6（::ffff:a.b.c.d）の上位96bitを右シフトで取り出した値がこれに一致するかで判定する。
const V4_MAPPED_HI = 0xffffn; // groups[5] === ffff for ::ffff:a.b.c.d

/**
 * Resolve a remote address to a comparable {version, value}. An IPv4-mapped
 * IPv6 address is unwrapped to its embedded IPv4 so it matches both v4 and v6
 * ranges as the operator expects.
 *
 * リクエストの送信元アドレス文字列を、CIDR 比較しやすい `{version, value}` 形式に正規化する。
 * IPv4-mapped IPv6 アドレスは埋め込まれた IPv4 部分に展開する（運用者が IPv4 の信頼レンジを
 * 設定していても、デュアルスタックソケット越しの接続で正しくマッチするようにするため）。
 * @param raw - 生のリモートアドレス文字列（ゾーンIDや角括弧を含んでいてもよい）。
 * @returns バージョンと値の組。パース不能な形式の場合は undefined。
 */
export function parseAddress(raw: string): { version: 4 | 6; value: bigint } | undefined {
  let ip = raw.trim();
  if (ip === '') return undefined;
  // Strip a zone id (`fe80::1%eth0`) and brackets (`[::1]`).
  // リンクローカルアドレスのゾーンID（%以降）と、URL 表記でよく使われる角括弧を取り除く。
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);

  if (!ip.includes(':')) {
    const v4 = parseIpv4(ip);
    return v4 === undefined ? undefined : { version: 4, value: v4 };
  }
  const v6 = parseIpv6(ip);
  if (v6 === undefined) return undefined;
  // ::ffff:a.b.c.d -> treat as the embedded IPv4.
  // 上位96bitを取り出し、IPv4-mapped IPv6 特有のパターン（0xffff）と一致すれば
  // 下位32bitを IPv4 アドレスとして扱う。
  const hi96 = v6 >> 32n;
  if (hi96 === V4_MAPPED_HI) {
    return { version: 4, value: v6 & 0xffffffffn };
  }
  return { version: 6, value: v6 };
}

/**
 * Parse a `address/prefix` (or a bare address = host route) CIDR string.
 *
 * `アドレス/プレフィックス長` 形式（プレフィックスを省略した場合はホストルートとして
 * 最大長を採用）の CIDR 文字列をパースする。
 * @param cidr - パース対象の CIDR 文字列（例: "10.0.0.0/8", "::1"）。
 * @returns パース済みの {@link ParsedCidr}。アドレス部とプレフィックス部のいずれかが不正なら undefined。
 */
export function parseCidr(cidr: string): ParsedCidr | undefined {
  const trimmed = cidr.trim();
  if (trimmed === '') return undefined;
  const slash = trimmed.indexOf('/');
  const addrPart = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const parsed = parseAddress(addrPart);
  if (!parsed) return undefined;
  const maxBits = parsed.version === 4 ? 32 : 128;
  let prefix: number;
  if (slash >= 0) {
    const p = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return undefined;
    prefix = Number(p);
    if (prefix > maxBits) return undefined; // v4なら32、v6なら128を超えるプレフィックスは不正
  } else {
    // スラッシュがない場合はホストルート（そのアドレス1つだけ）として最大プレフィックスを使う。
    prefix = maxBits;
  }
  const totalBits = parsed.version === 4 ? V4_BITS : V6_BITS;
  // prefix ビット分だけ1を立てたマスクを、アドレス長に合わせて上位に寄せる。
  // 例: v4, prefix=8 なら 0xFF000000（上位8bitが1、残りが0）。
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (totalBits - BigInt(prefix));
  // マスクをかけて下位ビットを0にすることで、任意のホストアドレスからネットワークベースアドレスを求める。
  return { version: parsed.version, base: parsed.value & mask, prefix };
}

/**
 * Parse a comma/space-separated CIDR list, dropping unparsable entries.
 *
 * カンマまたは空白区切りの CIDR リスト文字列（環境変数 `TRUSTED_PROXY_CIDRS` 等）をパースする。
 * @param list - CIDR を並べた文字列。
 * @returns パースに成功した {@link ParsedCidr} の配列。個々の不正なエントリは黙って読み飛ばす
 *          （リスト全体を無効にはしない）。
 */
export function parseCidrList(list: string): ParsedCidr[] {
  return list
    .split(/[,\s]+/) // カンマや空白（連続含む）で分割
    .map((s) => s.trim())
    .filter((s) => s !== '') // 空要素を除去
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== undefined); // 不正なエントリを除去
}

/**
 * True when `address` falls inside `cidr`. Versions must match.
 *
 * 指定した `address` が `cidr` の範囲内に含まれるかを判定する。バージョン（v4/v6）が
 * 異なる場合は常に false（呼び出し側の {@link parseAddress} での正規化が前提）。
 * @param cidr - 判定対象の CIDR レンジ。
 * @param address - 判定したいアドレス文字列。
 * @returns 範囲内なら true。
 */
export function cidrContains(cidr: ParsedCidr, address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (parsed.version !== cidr.version) return false; // v4 と v6 は絶対に一致しない
  const totalBits = cidr.version === 4 ? V4_BITS : V6_BITS;
  // parseCidr と同じ考え方でプレフィックス長からマスクを再構築する。
  const mask =
    cidr.prefix === 0
      ? 0n
      : ((1n << BigInt(cidr.prefix)) - 1n) << (totalBits - BigInt(cidr.prefix));
  // 対象アドレスにも同じマスクを適用し、CIDR のベースアドレスと一致すれば同一ネットワーク内。
  return (parsed.value & mask) === cidr.base;
}

/**
 * True when `address` is inside any range in the list.
 *
 * `address` が `cidrs` のいずれかのレンジに含まれるかを判定する。auth/principal.ts の
 * `PrincipalResolver.isTrusted()` から呼ばれ、信頼済みプロキシ判定の最終結果となる。
 * @param cidrs - 信頼済み CIDR レンジの配列。
 * @param address - 判定したいアドレス文字列。undefined の場合は常に信頼しない。
 * @returns いずれかのレンジに含まれれば true。
 */
export function isTrustedAddress(cidrs: ParsedCidr[], address: string | undefined): boolean {
  if (address === undefined) return false; // アドレスが取得できない接続は信頼しない
  return cidrs.some((c) => cidrContains(c, address));
}
