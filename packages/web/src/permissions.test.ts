import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@hubble/contracts';
import { hasPermission } from './permissions';

const operator: MeResponse = {
  user: 'op',
  authMode: 'proxy',
  role: 'operator',
  permissions: ['queries.viewAll', 'query.killAny', 'query.write'],
};

const member: MeResponse = {
  user: 'member',
  authMode: 'proxy',
  role: 'member',
  permissions: [],
};

describe('hasPermission', () => {
  it('returns true when permission is present', () => {
    expect(hasPermission(operator, 'queries.viewAll')).toBe(true);
    expect(hasPermission(operator, 'query.killAny')).toBe(true);
  });

  it('returns false when permission is absent', () => {
    expect(hasPermission(member, 'queries.viewAll')).toBe(false);
    expect(hasPermission(member, 'query.killAny')).toBe(false);
  });

  it('returns false when me is undefined', () => {
    expect(hasPermission(undefined, 'queries.viewAll')).toBe(false);
  });
});
