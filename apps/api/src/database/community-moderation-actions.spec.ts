import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMMUNITY_MODERATION_ACTIONS,
  COMMUNITY_MODERATION_TARGETS,
} from '../communities/community-moderation-log.service';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

const TABLE = /CREATE TABLE community_moderation_actions \(([\s\S]*?)\n\);/;

// Added by migration 023; 021 is released and append-only.
const ADDED_ACTIONS = ['community_updated', 'community_deleted'];
const ADDED_TARGETS = ['community'];
const ORIGINAL_ACTIONS = COMMUNITY_MODERATION_ACTIONS.filter(
  (action) => !ADDED_ACTIONS.includes(action),
);
const ORIGINAL_TARGETS = COMMUNITY_MODERATION_TARGETS.filter(
  (target) => !ADDED_TARGETS.includes(target),
);

const snapshot = read('../../../../data/community.sql');

describe('migration 021 (community moderation actions)', () => {
  const migration = read(
    '../../../../data/migrations/021_create_community_moderation_actions.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const table = normalise(TABLE.exec(migration)?.[1] ?? '');

  it('creates only the table', () => {
    expect(sql.split(';').filter((statement) => statement.trim())).toHaveLength(
      1,
    );
    expect(sql).toMatch(/^CREATE TABLE community_moderation_actions \(/);
  });

  it('declares the original enums, which the constants extend only by appending', () => {
    expect(
      COMMUNITY_MODERATION_ACTIONS.slice(0, ORIGINAL_ACTIONS.length),
    ).toEqual(ORIGINAL_ACTIONS);
    expect(table).toContain(
      `action ENUM( ${enumList(ORIGINAL_ACTIONS)} ) NOT NULL`,
    );
    expect(table).toContain(
      `target_type ENUM(${enumList(ORIGINAL_TARGETS)}) NOT NULL`,
    );
  });

  it('snapshots the actor and keeps polymorphic targets unlinked', () => {
    expect(table).toContain('actor_id VARCHAR(36) NULL');
    expect(table).toContain('actor_username VARCHAR(50) NOT NULL');
    expect(table).toContain(
      'FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE',
    );
    expect(table).toContain(
      'FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(table.match(/FOREIGN KEY/g)).toHaveLength(2);
    expect(table).not.toMatch(/FOREIGN KEY\s*\(\s*target_id\s*\)/i);
  });

  it('declares exactly the four lookup indexes', () => {
    expect(
      table.match(/INDEX idx_community_moderation_actions_\w+ \([^)]*\)/g),
    ).toEqual([
      'INDEX idx_community_moderation_actions_community (community_id, created_at, id)',
      'INDEX idx_community_moderation_actions_actor (community_id, actor_username, created_at)',
      'INDEX idx_community_moderation_actions_action (community_id, action, created_at)',
      'INDEX idx_community_moderation_actions_target (target_type, target_id, created_at)',
    ]);
  });

  it('states re-run safety', () => {
    expect(migration).toMatch(
      /Not safely re-runnable: if the table exists but this version is unrecorded,\r?\n-- drop community_moderation_actions and run this migration again\./,
    );
  });
});

describe('migration 023 (community moderation community actions)', () => {
  const migration = read(
    '../../../../data/migrations/023_add_community_moderation_community_actions.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));

  it('appends the community actions and target to both enums', () => {
    expect(sql).toBe(
      'ALTER TABLE community_moderation_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(COMMUNITY_MODERATION_ACTIONS)} ) NOT NULL, ` +
        `MODIFY COLUMN target_type ENUM(${enumList(COMMUNITY_MODERATION_TARGETS)}) NOT NULL;`,
    );
  });

  it('states re-run safety', () => {
    expect(migration).toMatch(/Safe to re-run/);
  });
});

describe('community_moderation_actions in the snapshot', () => {
  it('is 021 with the enums of 023', () => {
    const migration = read(
      '../../../../data/migrations/021_create_community_moderation_actions.sql',
    );
    const expected = normalise(TABLE.exec(migration)?.[1] ?? '')
      .replace(
        `action ENUM( ${enumList(ORIGINAL_ACTIONS)} )`,
        `action ENUM( ${enumList(COMMUNITY_MODERATION_ACTIONS)} )`,
      )
      .replace(
        `target_type ENUM(${enumList(ORIGINAL_TARGETS)})`,
        `target_type ENUM(${enumList(COMMUNITY_MODERATION_TARGETS)})`,
      );
    expect(normalise(TABLE.exec(snapshot)?.[1] ?? '')).toBe(expected);
  });

  it('records 021 through 023 in order', () => {
    expect(normalise(snapshot)).toContain(
      "('020_add_user_account_deletion'), ('021_create_community_moderation_actions'), " +
        "('022_add_community_deletion'), ('023_add_community_moderation_community_actions');",
    );
  });
});
