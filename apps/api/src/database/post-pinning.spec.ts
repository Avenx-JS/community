import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNITY_MODERATION_ACTIONS } from '../communities/community-moderation-log.service';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 026 (post pinning)', () => {
  const migration = read(
    '../../../../data/migrations/026_add_post_pinning.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const header = migration
    .split(/\r?\n/)
    .filter((line) => line.startsWith('--'))
    .join(' ');
  const snapshot = normalise(read('../../../../data/community.sql'));
  const posts =
    /CREATE TABLE posts \((.*?)\);/.exec(snapshot)?.[1] ?? 'missing posts';

  it('adds the columns, foreign key, check and index, and nothing else', () => {
    expect(sql).toBe(
      'ALTER TABLE posts ' +
        'ADD COLUMN pinned_at TIMESTAMP NULL DEFAULT NULL, ' +
        'ADD COLUMN pinned_by VARCHAR(36) NULL, ' +
        'ADD CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL, ' +
        'ADD CONSTRAINT chk_posts_pin CHECK ((pinned_at IS NULL AND pinned_by IS NULL) OR pinned_at IS NOT NULL); ' +
        'CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);',
    );
  });

  it('states in its header that it is not safely re-runnable', () => {
    expect(header).toContain(
      'Not safely re-runnable after partial application',
    );
  });

  it('is mirrored in the snapshot, with the version recorded last', () => {
    expect(posts).toContain('pinned_at TIMESTAMP NULL DEFAULT NULL,');
    expect(posts).toContain('pinned_by VARCHAR(36) NULL,');
    expect(posts).toContain(
      'CONSTRAINT chk_posts_pin CHECK ((pinned_at IS NULL AND pinned_by IS NULL) OR pinned_at IS NOT NULL)',
    );
    expect(posts).toContain(
      'CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(snapshot).toContain(
      'CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);',
    );
    expect(snapshot).toContain(
      "('025_add_community_suspension'), ('026_add_post_pinning');",
    );
  });

  it('needs no enum change: post_pinned and post_unpinned already exist', () => {
    expect(COMMUNITY_MODERATION_ACTIONS).toEqual(
      expect.arrayContaining(['post_pinned', 'post_unpinned']),
    );
    expect(sql).not.toContain('community_moderation_actions');
  });
});
