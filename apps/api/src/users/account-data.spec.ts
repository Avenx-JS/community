import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import {
  ConflictException,
  GoneException,
  ValidationPipe,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import {
  DataExportService,
  EXPORT_SECTIONS,
  EXPIRE_EXPORTS_SQL,
  FAIL_STALE_EXPORTS_SQL,
} from './data-export.service';
import {
  DEFAULT_USER_PREFERENCES,
  UpdateUserPreferencesDto,
} from './dto/user-preferences.dto';
import {
  APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL,
  UserPreferencesService,
} from './user-preferences.service';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const valid = {
  email_notifications: false,
  new_community_notifications: false,
  show_nsfw: true,
  timezone: 'Europe/Berlin',
  language: 'de',
};
const parse = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: UpdateUserPreferencesDto });

describe('PUT /users/me/preferences', () => {
  it.each([
    valid,
    { ...valid, timezone: 'UTC', language: 'en-GB' },
    {
      ...valid,
      timezone: 'America/Argentina/Buenos_Aires',
      language: 'zh-Hant-TW',
    },
  ])('accepts %o', async (body) => {
    await expect(parse(body)).resolves.toMatchObject(body);
  });

  // PUT replaces the whole set: every field is required.
  it.each([
    { ...valid, timezone: undefined },
    { ...valid, show_nsfw: 'yes' },
    { ...valid, timezone: 'Mars/Olympus' },
    { ...valid, timezone: 'europe/berlin' },
    { ...valid, language: 'German' },
    { ...valid, language: 'de_DE' },
    { ...valid, theme: 'dark' },
    {},
  ])('refuses %o', async (body) => {
    await expect(parse(body)).rejects.toThrow();
  });

  it('answers the defaults for an account that never set any, without writing', async () => {
    const statements: string[] = [];
    const pool = {
      execute: (sql: string) => {
        statements.push(sql);
        return Promise.resolve([[], []]);
      },
    } as unknown as Pool;
    await expect(new UserPreferencesService(pool).get('u')).resolves.toEqual(
      DEFAULT_USER_PREFERENCES,
    );
    expect(statements.every((sql) => sql.startsWith('SELECT'))).toBe(true);
  });

  it('applies the default for new communities without overriding a choice already made', () => {
    expect(APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL).toContain(
      'user_preferences.new_community_notifications = FALSE',
    );
    expect(APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL).toContain(
      'ON DUPLICATE KEY UPDATE new_posts = community_notification_preferences.new_posts',
    );
  });
});

describe('data export', () => {
  // An in-memory data_exports table.
  function harness() {
    const exports: Array<{
      id: string;
      user_id: string;
      status: string;
      payload: Buffer | null;
      expires_at: Date | null;
      created_at: Date;
    }> = [];
    const execute = (sql: string, values: unknown[] = []) => {
      const v = values as string[];
      const rows = (r: unknown) => Promise.resolve([r, []]);
      if (sql === EXPIRE_EXPORTS_SQL || sql === FAIL_STALE_EXPORTS_SQL) {
        return rows({ affectedRows: 0 });
      }
      if (sql.startsWith('SELECT id FROM users')) return rows([{ id: v[0] }]);
      if (
        sql.startsWith(
          "SELECT id FROM data_exports WHERE user_id = ? AND status = 'pending'",
        )
      ) {
        return rows(
          exports.filter((e) => e.user_id === v[0] && e.status === 'pending'),
        );
      }
      if (sql.startsWith('INSERT INTO data_exports')) {
        exports.push({
          id: v[0],
          user_id: v[1],
          status: 'pending',
          payload: null,
          expires_at: null,
          created_at: new Date(),
        });
        return rows({ affectedRows: 1 });
      }
      if (
        sql.startsWith(
          'SELECT id, status, created_at, expires_at FROM data_exports',
        )
      ) {
        return rows(exports.filter((e) => e.id === v[0] && e.user_id === v[1]));
      }
      if (sql.startsWith('SELECT payload FROM data_exports')) {
        return rows(
          exports.filter(
            (e) => e.id === v[0] && e.user_id === v[1] && e.status === 'ready',
          ),
        );
      }
      if (sql.startsWith("UPDATE data_exports SET status = 'downloaded'")) {
        const e = exports.find((x) => x.id === v[0] && x.status === 'ready');
        if (e) Object.assign(e, { status: 'downloaded', payload: null });
        return rows({ affectedRows: e ? 1 : 0 });
      }
      if (sql.startsWith("UPDATE data_exports SET status = 'ready'")) {
        const e = exports.find(
          (x) => x.id === values[3] && x.status === 'pending',
        );
        if (e)
          Object.assign(e, {
            status: 'ready',
            payload: values[0],
            expires_at: new Date(Date.now() + 3600_000),
          });
        return rows({ affectedRows: e ? 1 : 0 });
      }
      if (sql.startsWith("UPDATE data_exports SET status = 'failed'")) {
        const e = exports.find((x) => x.id === v[0]);
        if (e) e.status = 'failed';
        return rows({ affectedRows: 1 });
      }
      // The sections: one row each.
      if (EXPORT_SECTIONS.some(([, s]) => s === sql)) {
        return rows([{ sample: sql.slice(7, 30) }]);
      }
      if (sql.startsWith('SELECT email_notifications')) return rows([]);
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool;
    const service = new DataExportService(
      pool,
      new UserPreferencesService(pool),
    );
    return { service, exports };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('answers at once while pending, then gives the file exactly once', async () => {
    const { service, exports } = harness();
    const requested = await service.request('u-1');
    expect(requested).toMatchObject({ status: 'pending', expires_at: null });
    await expect(service.request('u-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await settle();
    expect(exports[0].status).toBe('ready');

    const first = await service.download('u-1', requested.id);
    expect(first.kind).toBe('file');
    const body = JSON.parse(
      (first as { body: Buffer }).body.toString('utf8'),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      format: 'community-data-export/1',
      preferences: DEFAULT_USER_PREFERENCES,
    });
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(EXPORT_SECTIONS.map(([name]) => name)),
    );
    expect(exports[0]).toMatchObject({ status: 'downloaded', payload: null });

    await expect(service.download('u-1', requested.id)).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it("is another account's 404", async () => {
    const { service } = harness();
    const requested = await service.request('u-1');
    await expect(service.download('u-2', requested.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('answers a failed export with 409, so a new one can be requested', async () => {
    const { service, exports } = harness();
    const requested = await service.request('u-1');
    await settle();
    exports[0].status = 'failed';
    await expect(service.download('u-1', requested.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.request('u-1')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('never reads a password hash, a token or anything about the account by others', () => {
    const sql = EXPORT_SECTIONS.map(([, statement]) => statement).join('\n');
    expect(sql).not.toMatch(
      /password_hash|token_hash|reported_user_id|target_author_id|resolution_note|removal_reason/,
    );
    // Each section is bound to the account alone.
    for (const [, statement] of EXPORT_SECTIONS) {
      expect(statement.match(/\?/g)).toHaveLength(1);
    }
  });
});
