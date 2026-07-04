import { describe, expect, it } from 'vitest';
import type { Permission } from '@hubble/contracts';
import { hasPermission, requirePermission } from './check';
import type { ResolvedRole } from './types';

const viewerRole: ResolvedRole = {
  name: 'viewer',
  permissions: new Set<Permission>(['queries.viewAll']),
};

describe('requirePermission', () => {
  it('no-ops when permission is present', () => {
    expect(() => requirePermission(viewerRole, 'queries.viewAll')).not.toThrow();
  });

  it('throws FORBIDDEN when permission is missing', () => {
    try {
      requirePermission(viewerRole, 'query.killAny');
      expect.fail('expected requirePermission to throw');
    } catch (err) {
      expect(err).toMatchObject({
        status: 403,
        detail: { code: 'FORBIDDEN' },
      });
    }
  });
});

describe('hasPermission', () => {
  it('reflects role permissions', () => {
    expect(hasPermission(viewerRole, 'queries.viewAll')).toBe(true);
    expect(hasPermission(viewerRole, 'query.write')).toBe(false);
  });
});
