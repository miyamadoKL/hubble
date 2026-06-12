import { describe, it, expect } from 'vitest';
import {
  cidrContains,
  isTrustedAddress,
  parseAddress,
  parseCidr,
  parseCidrList,
} from './cidr';

describe('parseAddress', () => {
  it('parses IPv4', () => {
    expect(parseAddress('127.0.0.1')?.version).toBe(4);
    expect(parseAddress('10.0.0.5')).toEqual({ version: 4, value: 0x0a000005n });
  });

  it('parses IPv6 incl. loopback and compression', () => {
    expect(parseAddress('::1')).toEqual({ version: 6, value: 1n });
    expect(parseAddress('2001:db8::1')?.version).toBe(6);
  });

  it('unwraps IPv4-mapped IPv6 to IPv4', () => {
    const mapped = parseAddress('::ffff:127.0.0.1');
    expect(mapped?.version).toBe(4);
    expect(mapped?.value).toBe(parseAddress('127.0.0.1')?.value);
  });

  it('handles hex-form IPv4-mapped IPv6', () => {
    // ::ffff:7f00:0001 === ::ffff:127.0.0.1
    expect(parseAddress('::ffff:7f00:1')).toEqual(parseAddress('127.0.0.1'));
  });

  it('strips brackets and zone ids', () => {
    expect(parseAddress('[::1]')).toEqual({ version: 6, value: 1n });
    expect(parseAddress('fe80::1%eth0')?.version).toBe(6);
  });

  it('rejects malformed input', () => {
    expect(parseAddress('')).toBeUndefined();
    expect(parseAddress('256.0.0.1')).toBeUndefined();
    expect(parseAddress('1.2.3')).toBeUndefined();
    expect(parseAddress('xyz')).toBeUndefined();
    expect(parseAddress(':::1')).toBeUndefined();
  });
});

describe('parseCidr', () => {
  it('parses an IPv4 range', () => {
    const c = parseCidr('127.0.0.0/8');
    expect(c).toMatchObject({ version: 4, prefix: 8 });
  });

  it('treats a bare address as a host route', () => {
    expect(parseCidr('::1')).toMatchObject({ version: 6, prefix: 128 });
    expect(parseCidr('10.1.2.3')).toMatchObject({ version: 4, prefix: 32 });
  });

  it('rejects an over-long prefix', () => {
    expect(parseCidr('10.0.0.0/33')).toBeUndefined();
    expect(parseCidr('::1/129')).toBeUndefined();
  });
});

describe('cidrContains', () => {
  const v4 = parseCidr('127.0.0.0/8')!;
  const v6Loop = parseCidr('::1/128')!;
  const v6Net = parseCidr('2001:db8::/32')!;

  it('matches addresses inside an IPv4 range', () => {
    expect(cidrContains(v4, '127.0.0.1')).toBe(true);
    expect(cidrContains(v4, '127.255.255.254')).toBe(true);
    expect(cidrContains(v4, '10.0.0.1')).toBe(false);
  });

  it('matches the IPv6 loopback host route', () => {
    expect(cidrContains(v6Loop, '::1')).toBe(true);
    expect(cidrContains(v6Loop, '::2')).toBe(false);
  });

  it('matches inside an IPv6 network', () => {
    expect(cidrContains(v6Net, '2001:db8::1234')).toBe(true);
    expect(cidrContains(v6Net, '2001:db9::1')).toBe(false);
  });

  it('matches an IPv4-mapped IPv6 peer against an IPv4 range', () => {
    expect(cidrContains(v4, '::ffff:127.0.0.1')).toBe(true);
    expect(cidrContains(v4, '::ffff:10.0.0.1')).toBe(false);
  });

  it('does not cross address families', () => {
    expect(cidrContains(v4, '::1')).toBe(false);
    expect(cidrContains(v6Loop, '127.0.0.1')).toBe(false);
  });
});

describe('parseCidrList + isTrustedAddress', () => {
  const defaults = parseCidrList('127.0.0.0/8,::1/128');

  it('parses the default trusted list', () => {
    expect(defaults).toHaveLength(2);
  });

  it('trusts loopback v4, v6, and mapped v4; rejects others', () => {
    expect(isTrustedAddress(defaults, '127.0.0.1')).toBe(true);
    expect(isTrustedAddress(defaults, '::1')).toBe(true);
    expect(isTrustedAddress(defaults, '::ffff:127.0.0.1')).toBe(true);
    expect(isTrustedAddress(defaults, '192.168.1.10')).toBe(false);
    expect(isTrustedAddress(defaults, undefined)).toBe(false);
  });

  it('drops unparsable entries but keeps valid ones', () => {
    const list = parseCidrList('garbage, 10.0.0.0/8 , , 256.0.0.0/8');
    expect(list).toHaveLength(1);
    expect(isTrustedAddress(list, '10.5.5.5')).toBe(true);
  });
});
