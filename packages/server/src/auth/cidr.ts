/**
 * Minimal CIDR membership test for the trusted-proxy boundary (design.md §11).
 *
 * Supports IPv4 and IPv6 ranges. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`,
 * which is how Node reports an IPv4 peer on a dual-stack socket) is matched
 * against both IPv4 and IPv6 ranges by normalizing it to its embedded IPv4. The
 * loopback addresses `127.0.0.0/8` (v4) and `::1/128` (v6) are the defaults.
 *
 * Implemented with BigInt bit math (v4 = 32-bit, v6 = 128-bit) — no dependency.
 */

export interface ParsedCidr {
  /** 4 for an IPv4 range, 6 for an IPv6 range. */
  version: 4 | 6;
  /** Network base address as a BigInt. */
  base: bigint;
  /** Prefix length in bits (0–32 for v4, 0–128 for v6). */
  prefix: number;
}

const V4_BITS = 32n;
const V6_BITS = 128n;

/** Parse a dotted-quad IPv4 string into a 32-bit BigInt, or undefined. */
export function parseIpv4(ip: string): bigint | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/**
 * Parse an IPv6 string into a 128-bit BigInt, or undefined. Handles `::`
 * compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 */
export function parseIpv6(ip: string): bigint | undefined {
  if (!ip.includes(':')) return undefined;
  // Reject more than one `::`.
  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return undefined;

  const expand = (segment: string): string[] => (segment === '' ? [] : segment.split(':'));

  let groups: string[];
  if (doubleColon.length === 2) {
    const head = expand(doubleColon[0]!);
    const tail = expand(doubleColon[1]!);
    const fill = 8 - (head.length + tail.length);
    if (fill < 0) return undefined;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = ip.split(':');
  }
  if (groups.length !== 8) return undefined;

  let value = 0n;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    // A trailing IPv4 may occupy the final two 16-bit groups.
    if (i === 7 && group.includes('.')) {
      const v4 = parseIpv4(group);
      if (v4 === undefined) return undefined;
      // The IPv4 fills groups 6 and 7; back out the placeholder we just added.
      value = (value << 16n) | (v4 >> 16n);
      value = (value << 16n) | (v4 & 0xffffn);
      return value & ((1n << V6_BITS) - 1n);
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

const V4_MAPPED_HI = 0xffffn; // groups[5] === ffff for ::ffff:a.b.c.d

/**
 * Resolve a remote address to a comparable {version, value}. An IPv4-mapped
 * IPv6 address is unwrapped to its embedded IPv4 so it matches both v4 and v6
 * ranges as the operator expects.
 */
export function parseAddress(
  raw: string,
): { version: 4 | 6; value: bigint } | undefined {
  let ip = raw.trim();
  if (ip === '') return undefined;
  // Strip a zone id (`fe80::1%eth0`) and brackets (`[::1]`).
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
  const hi96 = v6 >> 32n;
  if (hi96 === V4_MAPPED_HI) {
    return { version: 4, value: v6 & 0xffffffffn };
  }
  return { version: 6, value: v6 };
}

/** Parse a `address/prefix` (or a bare address = host route) CIDR string. */
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
    if (prefix > maxBits) return undefined;
  } else {
    prefix = maxBits;
  }
  const totalBits = parsed.version === 4 ? V4_BITS : V6_BITS;
  const mask =
    prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << (totalBits - BigInt(prefix)));
  return { version: parsed.version, base: parsed.value & mask, prefix };
}

/** Parse a comma/space-separated CIDR list, dropping unparsable entries. */
export function parseCidrList(list: string): ParsedCidr[] {
  return list
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== undefined);
}

/** True when `address` falls inside `cidr`. Versions must match. */
export function cidrContains(cidr: ParsedCidr, address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (parsed.version !== cidr.version) return false;
  const totalBits = cidr.version === 4 ? V4_BITS : V6_BITS;
  const mask =
    cidr.prefix === 0
      ? 0n
      : (((1n << BigInt(cidr.prefix)) - 1n) << (totalBits - BigInt(cidr.prefix)));
  return (parsed.value & mask) === cidr.base;
}

/** True when `address` is inside any range in the list. */
export function isTrustedAddress(cidrs: ParsedCidr[], address: string | undefined): boolean {
  if (address === undefined) return false;
  return cidrs.some((c) => cidrContains(c, address));
}
