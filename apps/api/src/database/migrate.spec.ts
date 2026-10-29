import { describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import {
  filterPendingMigrations,
  loadMigrations,
  Migration,
  MigrationConnection,
  orderMigrations,
  parseMigrationFilename,
  runMigrations,
} from './migrate';

function migration(version: string, order: number): Migration {
  return { version, order, sql: `SELECT '${version}';` };
}

describe('migration ordering and application', () => {
  it('parses and orders versions numerically', () => {
    expect(parseMigrationFilename('010_add_role.sql')).toBe(10);
    expect(
      orderMigrations([
        migration('010_add_role', 10),
        migration('009_add_email', 9),
      ]).map(({ version }) => version),
    ).toEqual(['009_add_email', '010_add_role']);
  });

  it('loads repository migrations in ascending order, each version once', async () => {
    const versions = (
      await loadMigrations(resolve(__dirname, '../../../../data/migrations'))
    ).map(({ version }) => version);
    const position = (version: string) => {
      expect(versions).toContain(version);
      return versions.indexOf(version);
    };

    expect(position('009_create_community_rule_documents')).toBe(
      position('008_add_report_analytics_indexes') + 1,
    );
    expect(position('010_create_notifications')).toBe(
      position('009_create_community_rule_documents') + 1,
    );
    expect(position('011_create_community_notification_preferences')).toBe(
      position('010_create_notifications') + 1,
    );
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('rejects migration files that do not follow the naming convention', () => {
    expect(() => parseMigrationFilename('add_role.sql')).toThrow(
      'Invalid migration filename',
    );
  });

  it('filters versions already recorded as applied', () => {
    const pending = filterPendingMigrations(
      [migration('002_add_post_type', 2), migration('001_add_user_role', 1)],
      new Set(['001_add_user_role']),
    );

    expect(pending.map(({ version }) => version)).toEqual([
      '002_add_post_type',
    ]);
  });

  it('executes pending files in order and records each only after success', async () => {
    const applied: string[] = [];
    const executions: string[] = [];
    const statements: string[] = [];
    const connection: MigrationConnection = {
      execute: (sql, values) => {
        statements.push(sql);
        if (sql === 'SELECT version FROM schema_migrations') {
          return Promise.resolve([[{ version: '001_existing' }], undefined]);
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          applied.push(values?.[0] ?? '');
        }
        return Promise.resolve([undefined, undefined]);
      },
      query: (sql) => {
        executions.push(sql);
        return Promise.resolve([undefined, undefined]);
      },
      end: () => Promise.resolve(),
    };
    const log = jest.fn<(message: string) => void>();

    await runMigrations(
      connection,
      [
        migration('003_add_votes', 3),
        migration('001_existing', 1),
        migration('002_add_posts', 2),
      ],
      log,
    );

    expect(executions).toEqual([
      "SELECT '002_add_posts';",
      "SELECT '003_add_votes';",
    ]);
    expect(applied).toEqual(['002_add_posts', '003_add_votes']);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Skipped 001_existing (already applied)',
      'Applied 002_add_posts',
      'Applied 003_add_votes',
    ]);
    expect(statements.filter((sql) => sql.startsWith('INSERT'))).toHaveLength(
      2,
    );
  });

  it('stops on a failed migration without recording it or later versions', async () => {
    const applied: string[] = [];
    const executions: string[] = [];
    const connection: MigrationConnection = {
      execute: (sql, values) => {
        if (sql === 'SELECT version FROM schema_migrations') {
          return Promise.resolve([[], undefined]);
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          applied.push(values?.[0] ?? '');
        }
        return Promise.resolve([undefined, undefined]);
      },
      query: (sql) => {
        executions.push(sql);
        if (sql.includes('002_fails')) {
          return Promise.reject(new Error('DDL failed'));
        }
        return Promise.resolve([undefined, undefined]);
      },
      end: () => Promise.resolve(),
    };

    await expect(
      runMigrations(
        connection,
        [
          migration('001_succeeds', 1),
          migration('002_fails', 2),
          migration('003_not_reached', 3),
        ],
        () => undefined,
      ),
    ).rejects.toThrow('DDL failed');

    expect(executions).toEqual([
      "SELECT '001_succeeds';",
      "SELECT '002_fails';",
    ]);
    expect(applied).toEqual(['001_succeeds']);
  });
});
