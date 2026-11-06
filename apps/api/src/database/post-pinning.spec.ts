import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNITY_MODERATION_ACTIONS } from '../communities/community-moderation-log.service';
import { checkTriggerRule, checkTriggerSql } from './check-trigger-rules';
import { removeTriggerRules } from './sql-script';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 026 (post pinning)', () => {
  const migration = read(
    '../../../../data/migrations/026_add_post_pinning.sql',
  );
  const rule = checkTriggerRule('chk_posts_pin');
  // The statements besides the trigger pair.
  const sql = normalise(
    removeTriggerRules(migration, rule.name).replace(/^--.*$/gm, ''),
  );
  const header = migration
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join(' ');
  const rawSnapshot = read('../../../../data/community.sql');
  const snapshot = normalise(rawSnapshot);
  const posts =
    /CREATE TABLE posts \((.*?)\);/.exec(snapshot)?.[1] ?? 'missing posts';

  it('adds the columns, foreign key, trigger pair and index, and nothing else', () => {
    expect(sql).toBe(
      'ALTER TABLE posts ' +
        'ADD COLUMN pinned_at TIMESTAMP NULL DEFAULT NULL, ' +
        'ADD COLUMN pinned_by VARCHAR(36) NULL, ' +
        'ADD CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL; ' +
        'CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);',
    );
    // chk_posts_pin cannot be a CHECK: pinned_by is ON DELETE SET NULL.
    expect(migration).toContain(checkTriggerSql(rule));
    expect(migration).not.toMatch(/CONSTRAINT chk_posts_pin CHECK/);
  });

  it('states in its header that it is not safely re-runnable', () => {
    expect(header).toContain(
      'Not safely re-runnable after partial application',
    );
    expect(header).toContain('trg_posts_pin_insert');
  });

  it('is mirrored in the snapshot, with the version recorded last', () => {
    expect(posts).toContain('pinned_at TIMESTAMP NULL DEFAULT NULL,');
    expect(posts).toContain('pinned_by VARCHAR(36) NULL,');
    expect(posts).toContain(
      'CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(posts).not.toContain('chk_posts_pin');
    expect(rawSnapshot).toContain(checkTriggerSql(rule));
    expect(snapshot).toContain(
      'CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);',
    );
    expect(snapshot).toContain(
      "('025_add_community_suspension'), ('026_add_post_pinning')",
    );
  });

  it('needs no enum change: post_pinned and post_unpinned already exist', () => {
    expect(COMMUNITY_MODERATION_ACTIONS).toEqual(
      expect.arrayContaining(['post_pinned', 'post_unpinned']),
    );
    expect(sql).not.toContain('community_moderation_actions');
  });
});
