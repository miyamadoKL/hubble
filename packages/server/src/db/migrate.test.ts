import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, runMigrations, appliedVersions } from './migrate';
import { openDatabase, MIGRATIONS_DIR } from './index';

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function withTempMigrations(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hf-mig-'));
  try {
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(dir, name), sql);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadMigrations', () => {
  it('orders by numeric prefix and ignores non-matching files', () => {
    withTempMigrations(
      {
        '0002_b.sql': 'CREATE TABLE b (id INTEGER);',
        '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
        'README.md': 'not a migration',
        'notes.sql.bak': 'ignored',
      },
      (dir) => {
        const migrations = loadMigrations(dir);
        expect(migrations.map((m) => m.version)).toEqual([1, 2]);
        expect(migrations.map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
      },
    );
  });

  it('throws on duplicate version numbers', () => {
    withTempMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' }, (dir) => {
      expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version 1/);
    });
  });
});

describe('runMigrations', () => {
  it('applies pending migrations once and is idempotent', () => {
    withTempMigrations(
      {
        '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
        '0002_b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
      },
      (dir) => {
        const db = new Database(':memory:');
        const migrations = loadMigrations(dir);

        const first = runMigrations(db, migrations);
        expect(first).toEqual([1, 2]);
        expect(appliedVersions(db)).toEqual([1, 2]);
        expect(tableNames(db)).toContain('a');
        expect(tableNames(db)).toContain('b');

        // Re-running applies nothing.
        const second = runMigrations(db, migrations);
        expect(second).toEqual([]);
        expect(appliedVersions(db)).toEqual([1, 2]);
        db.close();
      },
    );
  });

  it('applies only newly added migrations on a second pass', () => {
    const db = new Database(':memory:');
    withTempMigrations({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' }, (dir) => {
      runMigrations(db, loadMigrations(dir));
    });
    expect(appliedVersions(db)).toEqual([1]);

    withTempMigrations(
      {
        '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
        '0002_c.sql': 'CREATE TABLE c (id INTEGER);',
      },
      (dir) => {
        const applied = runMigrations(db, loadMigrations(dir));
        expect(applied).toEqual([2]);
      },
    );
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tableNames(db)).toContain('c');
    db.close();
  });

  it('rolls back a failing migration (no partial bookkeeping)', () => {
    withTempMigrations(
      {
        '0001_ok.sql': 'CREATE TABLE ok (id INTEGER);',
        '0002_bad.sql': 'CREATE TABLE bad (id INTEGER); THIS IS NOT SQL;',
      },
      (dir) => {
        const db = new Database(':memory:');
        const migrations = loadMigrations(dir);
        expect(() => runMigrations(db, migrations)).toThrow();
        // Migration 1 committed; migration 2 fully rolled back.
        expect(appliedVersions(db)).toEqual([1]);
        expect(tableNames(db)).toContain('ok');
        expect(tableNames(db)).not.toContain('bad');
        db.close();
      },
    );
  });
});

describe('openDatabase with the real initial migration', () => {
  it('creates notebooks / saved_queries / query_history', () => {
    const db = openDatabase(':memory:');
    const names = tableNames(db);
    expect(names).toContain('notebooks');
    expect(names).toContain('saved_queries');
    expect(names).toContain('query_history');
    expect(names).toContain('schema_migrations');
    expect(appliedVersions(db)).toContain(1);
    db.close();
  });

  it('loads the real migrations directory', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]!.version).toBe(1);
  });
});
