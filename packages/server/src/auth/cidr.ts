/**
 * 信頼済みプロキシ境界で使う CIDR 所属判定。
 *
 * IPv4 と IPv6 に対応し、IPv4-mapped IPv6（`::ffff:a.b.c.d`）は IPv4 レンジと比較する。
 * PrincipalResolver は、送信元が信頼済みプロキシの CIDR に含まれる場合だけ SSO ヘッダーを信用する。
 * 既定の loopback レンジは IPv4 の `127.0.0.0/8` と IPv6 の `::1/128` である。
 * 構文解析と所属判定は ipaddr.js に委譲し、第三者パッケージの型はアダプターの内部に閉じ込める。
 * 外側の角括弧とゾーン ID は、既存方針に合わせて解析の前に正規化する。
 *
 * Node 標準の `net.BlockList` は採用しない。IPv6 の `/0` と plain IPv4 アドレスの
 * 照合、および IPv4-mapped CIDR の family semantics が、このファイルが提供する
 * 現行の contract（IPv4-mapped IPv6 を IPv4 レンジと比較する等）と異なるため、
 * security boundary で独自補正を増やすより ipaddr.js を選ぶ。
 */
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** パース済み CIDR の公開契約。レンジ判定関数は ipaddr.js の値を閉じ込める。 */
export interface ParsedCidr {
  /** IPv4 レンジなら 4、IPv6 レンジなら 6。 */
  version: 4 | 6;
  /** プレフィックス長。v4 は 0〜32、v6 は 0〜128。 */
  prefix: number;
  /** 文字列アドレスをレンジに照合する不透明な判定関数。 */
  contains(address: string): boolean;
}

type IpaddrAddress = ipaddr.IPv4 | ipaddr.IPv6;

/** 既存順序どおり角括弧を外し、最初のゾーン ID 区切り以降を除去してから検証する。 */
function parseIpaddrAddress(raw: string): IpaddrAddress | undefined {
  let address = raw.trim();
  if (address === '') return undefined;
  const startsWithBracket = address.startsWith('[');
  const endsWithBracket = address.endsWith(']');
  if (startsWithBracket !== endsWithBracket) return undefined;
  if (startsWithBracket) address = address.slice(1, -1);
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  const family = isIP(address);
  if (family === 4 && !ipaddr.IPv4.isValidFourPartDecimal(address)) return undefined;
  if (family !== 4 && family !== 6) return undefined;
  try {
    return ipaddr.process(address);
  } catch {
    return undefined;
  }
}

/** アドレス種別だけを返す独自値。 */
export function parseAddress(raw: string): { version: 4 | 6 } | undefined {
  const parsed = parseIpaddrAddress(raw);
  return parsed === undefined ? undefined : { version: parsed.kind() === 'ipv4' ? 4 : 6 };
}

/** `アドレス/プレフィックス` またはホストルートをパースする。 */
export function parseCidr(cidr: string): ParsedCidr | undefined {
  const trimmed = cidr.trim();
  if (trimmed === '') return undefined;
  const slash = trimmed.indexOf('/');
  if (slash >= 0 && slash !== trimmed.lastIndexOf('/')) return undefined;
  const parsed = parseIpaddrAddress(slash >= 0 ? trimmed.slice(0, slash) : trimmed);
  if (parsed === undefined) return undefined;

  const kind = parsed.kind();
  const maxPrefix = kind === 'ipv4' ? 32 : 128;
  const prefixText = slash < 0 ? undefined : trimmed.slice(slash + 1);
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (prefix > maxPrefix) return undefined;

  return {
    version: kind === 'ipv4' ? 4 : 6,
    prefix,
    contains(address: string): boolean {
      const candidate = parseIpaddrAddress(address);
      return (
        candidate !== undefined && candidate.kind() === kind && parsed.match(candidate, prefix)
      );
    },
  };
}

/** カンマまたは空白区切りの CIDR リストをパースし、不正な要素を読み飛ばす。 */
export function parseCidrList(list: string): ParsedCidr[] {
  return list
    .split(/[,\s]+/)
    .filter((entry) => entry !== '')
    .map(parseCidr)
    .filter((cidr): cidr is ParsedCidr => cidr !== undefined);
}

/** アドレスが CIDR に含まれるかを判定する。アドレス種別は交差させない。 */
export function cidrContains(cidr: ParsedCidr, address: string): boolean {
  return cidr.contains(address);
}

/** アドレスがリスト内のいずれかの CIDR に含まれるかを判定する。 */
export function isTrustedAddress(cidrs: ParsedCidr[], address: string | undefined): boolean {
  return address !== undefined && cidrs.some((cidr) => cidrContains(cidr, address));
}
