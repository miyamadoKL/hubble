/**
 * principal.ts（SSO ヘッダーから Principal を解決するロジック）のユニットテスト。
 * mapPrincipal のヘッダー -> principal マッピング規則、および PrincipalResolver の
 * 信頼済みプロキシ判定込みの解決フロー（trusted/untrusted、ヘッダー欠落）を検証する。
 */
import { describe, it, expect } from 'vitest';
import type { AuthConfig } from '../config';
import { mapPrincipal, PrincipalResolver } from './principal';

// テスト共通の AuthConfig（proxy モード、ループバックを信頼、email-localpart マッピング）。
// `over` で個々のテストが必要な項目だけ上書きできる。
const baseAuth = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  mode: 'proxy',
  trustedProxyCidrs: '127.0.0.0/8,::1/128',
  ssoHeaderUser: 'x-forwarded-user',
  ssoHeaderEmail: 'x-forwarded-email',
  userMapping: 'email-localpart',
  ...over,
});

// mapPrincipal: userMapping ごとのヘッダー -> Principal 変換規則を検証する。
describe('mapPrincipal', () => {
  it('email-localpart: takes the part before @', () => {
    expect(mapPrincipal('email-localpart', 'ignored', 'alice@example.com')).toEqual({
      user: 'alice',
      email: 'alice@example.com',
    });
  });

  it('email-localpart: falls back to whole value when no @', () => {
    expect(mapPrincipal('email-localpart', undefined, 'bob')?.user).toBe('bob');
  });

  it('email: uses the full address as the principal', () => {
    expect(mapPrincipal('email', 'ignored', 'alice@example.com')).toEqual({
      user: 'alice@example.com',
      email: 'alice@example.com',
    });
  });

  it('user: uses the user header verbatim', () => {
    expect(mapPrincipal('user', 'corp\\alice', 'alice@example.com')).toEqual({
      user: 'corp\\alice',
      email: 'alice@example.com',
    });
  });

  it('returns undefined when the required header is missing', () => {
    expect(mapPrincipal('email-localpart', 'alice', undefined)).toBeUndefined();
    expect(mapPrincipal('email', undefined, undefined)).toBeUndefined();
    expect(mapPrincipal('user', '   ', 'a@b.com')).toBeUndefined();
  });
});

// PrincipalResolver: 信頼済みプロキシ判定込みの resolve() の挙動、
// マッピング方式の切り替え、ヘッダー名のカスタマイズを検証する。
describe('PrincipalResolver', () => {
  it('resolves a principal from trusted headers (email-localpart)', () => {
    const r = new PrincipalResolver(baseAuth());
    const res = r.resolve({ 'x-forwarded-email': 'alice@corp.com' }, '127.0.0.1');
    expect(res).toEqual({ ok: true, principal: { user: 'alice', email: 'alice@corp.com' } });
  });

  it('honors all three mappings', () => {
    const headers = { 'x-forwarded-user': 'auser', 'x-forwarded-email': 'alice@corp.com' };
    expect(
      new PrincipalResolver(baseAuth({ userMapping: 'user' })).resolve(headers, '::1'),
    ).toMatchObject({ ok: true, principal: { user: 'auser' } });
    expect(
      new PrincipalResolver(baseAuth({ userMapping: 'email' })).resolve(headers, '::1'),
    ).toMatchObject({ ok: true, principal: { user: 'alice@corp.com' } });
    expect(
      new PrincipalResolver(baseAuth({ userMapping: 'email-localpart' })).resolve(headers, '::1'),
    ).toMatchObject({ ok: true, principal: { user: 'alice' } });
  });

  it('ignores SSO headers from an untrusted peer (→ unauthenticated)', () => {
    const r = new PrincipalResolver(baseAuth());
    const res = r.resolve({ 'x-forwarded-email': 'evil@corp.com' }, '203.0.113.7');
    expect(res.ok).toBe(false);
  });

  it('is unauthenticated when identity headers are absent (trusted peer)', () => {
    const r = new PrincipalResolver(baseAuth());
    expect(r.resolve({}, '127.0.0.1').ok).toBe(false);
  });

  it('trusts an IPv4-mapped IPv6 loopback peer', () => {
    const r = new PrincipalResolver(baseAuth());
    expect(r.isTrusted('::ffff:127.0.0.1')).toBe(true);
  });

  it('respects custom header names', () => {
    const r = new PrincipalResolver(
      baseAuth({ ssoHeaderEmail: 'x-auth-email', userMapping: 'email-localpart' }),
    );
    expect(r.resolve({ 'x-auth-email': 'carol@x.io' }, '127.0.0.1')).toMatchObject({
      ok: true,
      principal: { user: 'carol' },
    });
  });
});
