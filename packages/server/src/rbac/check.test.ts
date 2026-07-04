import { describe, expect, it } from 'vitest';
import type { Permission } from '@hubble/contracts';
import {
  filterDatasourcesForRole,
  hasPermission,
  requireDatasourceAccess,
  requirePermission,
  roleAllowsDatasource,
} from './check';
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

describe('roleAllowsDatasource', () => {
  const unrestricted: ResolvedRole = { name: 'unrestricted', permissions: new Set() };
  const explicitAll: ResolvedRole = {
    name: 'all',
    permissions: new Set(),
    datasources: ['*'],
  };
  const trinoOnly: ResolvedRole = {
    name: 'trino',
    permissions: new Set(),
    datasources: ['trino-prod'],
  };
  const none: ResolvedRole = { name: 'none', permissions: new Set(), datasources: [] };

  it('allows all datasources when datasources is omitted', () => {
    expect(roleAllowsDatasource(unrestricted, 'mysql-a')).toBe(true);
  });

  it('allows all datasources for wildcard allowlist', () => {
    expect(roleAllowsDatasource(explicitAll, 'mysql-a')).toBe(true);
  });

  it('allows only listed datasource ids', () => {
    expect(roleAllowsDatasource(trinoOnly, 'trino-prod')).toBe(true);
    expect(roleAllowsDatasource(trinoOnly, 'mysql-a')).toBe(false);
  });

  it('denies every datasource for an empty allowlist', () => {
    expect(roleAllowsDatasource(none, 'trino-prod')).toBe(false);
  });
});

describe('requireDatasourceAccess', () => {
  it('throws NOT_FOUND when datasource is not allowed', () => {
    const role: ResolvedRole = {
      name: 'trino',
      permissions: new Set(),
      datasources: ['trino-prod'],
    };
    try {
      requireDatasourceAccess(role, 'mysql-a');
      expect.fail('expected requireDatasourceAccess to throw');
    } catch (err) {
      expect(err).toMatchObject({
        status: 404,
        detail: { code: 'NOT_FOUND' },
      });
    }
  });
});

describe('filterDatasourcesForRole', () => {
  it('filters datasource summaries by role allowlist', () => {
    const role: ResolvedRole = {
      name: 'trino',
      permissions: new Set(),
      datasources: ['trino-prod'],
    };
    const filtered = filterDatasourcesForRole(
      [
        {
          id: 'trino-prod',
          type: 'trino',
          displayName: 'Trino',
          baseUrl: 'http://trino',
          username: 'u',
          password: 'p',
          source: 'hubble',
        },
        {
          id: 'mysql-a',
          type: 'mysql',
          displayName: 'MySQL',
          host: 'h',
          port: 3306,
          database: 'd',
          username: 'u',
          password: 'p',
          readOnly: true,
          tls: false,
          maxConnections: 4,
        },
      ],
      role,
    );
    expect(filtered.map((ds) => ds.id)).toEqual(['trino-prod']);
  });
});
