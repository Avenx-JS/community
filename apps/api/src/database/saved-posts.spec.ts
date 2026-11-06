import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const TABLE =
  'CREATE TABLE saved_posts ( ' +
  'user_id VARCHAR(36) NOT NULL, ' +
  'post_id VARCHAR(36) NOT NULL, ' +
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
  'PRIMARY KEY (user_id, post_id), ' +
  'INDEX idx_saved_posts_user_created (user_id, created_at, post_id), ' +
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, ' +
  'FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE );';

describe('migration 027 (saved posts)', () => {
  const migration = read(
    '../../../../data/migrations/027_create_saved_posts.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const header = migration
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join(' ');
  const snapshot = normalise(read('../../../../data/community.sql'));

  it('creates the table with its composite key, listing index and cascading keys, and nothing else', () => {
    expect(sql).toBe(TABLE);
  });

  it('states in its header that it is not safely re-runnable', () => {
    expect(header).toContain(
      'Not safely re-runnable after partial application',
    );
    expect(header).toContain('Saves are private');
  });

  it('is mirrored in the snapshot, with the version recorded last', () => {
    expect(snapshot).toContain(TABLE);
    // After both referenced tables exist.
    expect(snapshot.indexOf(TABLE)).toBeGreaterThan(
      snapshot.indexOf('CREATE TABLE posts ('),
    );
    expect(snapshot).toContain(
      "('026_add_post_pinning'), ('027_create_saved_posts')",
    );
  });
});
