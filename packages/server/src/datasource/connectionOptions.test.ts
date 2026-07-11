import { describe, expect, it } from 'vitest';
import { resolveDatasourceConnectTimeoutMs } from './connectionOptions';

describe('resolveDatasourceConnectTimeoutMs', () => {
  it('未設定時は10000ミリ秒を返す', () => {
    expect(resolveDatasourceConnectTimeoutMs({})).toBe(10_000);
  });

  it('正の整数を設定値として返す', () => {
    expect(resolveDatasourceConnectTimeoutMs({ DATASOURCE_CONNECT_TIMEOUT_MS: '2500' })).toBe(2500);
  });

  it('不正値を拒否する', () => {
    expect(() => resolveDatasourceConnectTimeoutMs({ DATASOURCE_CONNECT_TIMEOUT_MS: '0' })).toThrow(
      /minimum: 1/,
    );
  });
});
