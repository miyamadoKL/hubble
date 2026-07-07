import { describe, expect, it } from 'vitest';
import { buildPrompt, extractSql } from './prompts';

describe('extractSql', () => {
  it('returns the last sql fenced block when multiple blocks exist', () => {
    const text = [
      'First draft:',
      '```sql',
      'SELECT 1',
      '```',
      'Final:',
      '```sql',
      'SELECT 2',
      '```',
    ].join('\n');
    expect(extractSql(text)).toBe('SELECT 2');
  });

  it('returns undefined when no sql block exists', () => {
    expect(extractSql('plain text only')).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('includes dialect and SQL for explain', () => {
    const prompt = buildPrompt({ task: 'explain', sql: 'SELECT id FROM users' }, 'postgresql');
    expect(prompt.system).toContain('The target SQL dialect is postgresql.');
    expect(prompt.user).toContain('Task: explain');
    expect(prompt.user).toContain('SELECT id FROM users');
  });

  it('includes error message for fix', () => {
    const prompt = buildPrompt(
      {
        task: 'fix',
        sql: 'SELECT bad',
        errorMessage: 'column "bad" does not exist',
      },
      'trino',
    );
    expect(prompt.system).toContain('The target SQL dialect is trino.');
    expect(prompt.user).toContain('SELECT bad');
    expect(prompt.user).toContain('column "bad" does not exist');
  });

  it('includes table columns for draft', () => {
    const prompt = buildPrompt(
      {
        task: 'draft',
        instruction: 'count active users',
        tables: [
          {
            schema: 'public',
            table: 'users',
            columns: [
              { name: 'id', type: 'bigint' },
              { name: 'active', type: 'boolean' },
            ],
          },
        ],
      },
      'mysql',
    );
    expect(prompt.system).toContain('The target SQL dialect is mysql.');
    expect(prompt.user).toContain('count active users');
    expect(prompt.user).toContain('public.users');
    expect(prompt.user).toContain('id (bigint)');
    expect(prompt.user).toContain('active (boolean)');
  });
});
