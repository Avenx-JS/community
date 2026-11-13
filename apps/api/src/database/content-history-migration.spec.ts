import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 039 (content labels and history)', () => {
  const file = read(
    '../../../../data/migrations/039_add_content_labels_and_history.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  it('is in the snapshot verbatim, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Content labels, hidden posts, saved comments and revisions (039_add_content_labels_and_history). ${migration}`,
    );
    expect(snapshot).toContain(
      "('038_add_community_settings'), ('039_add_content_labels_and_history');",
    );
  });

  // Existing posts carry no label; nothing is backfilled.
  it('adds the labels unset, recording who set one', () => {
    expect(migration).toContain(
      "ADD COLUMN nsfw_set_by ENUM('author', 'moderator') NULL DEFAULT NULL",
    );
    expect(migration).toContain(
      "ADD COLUMN spoiler_set_by ENUM('author', 'moderator') NULL DEFAULT NULL",
    );
    expect(migration).not.toMatch(/UPDATE posts/);
  });

  // Saves, hides and revisions go with their post or comment, as saved_posts
  // does, and with the account.
  it('cascades every new table from its content', () => {
    const body = (table: string) =>
      migration.split(`CREATE TABLE ${table} (`)[1]?.split(';')[0] ?? '';
    for (const [table, parent] of [
      ['hidden_posts', 'posts'],
      ['saved_comments', 'comments'],
      ['post_revisions', 'posts'],
      ['comment_revisions', 'comments'],
    ]) {
      expect(body(table)).toContain(
        `REFERENCES ${parent}(id) ON DELETE CASCADE`,
      );
    }
    for (const table of ['hidden_posts', 'saved_comments']) {
      expect(body(table)).toContain('REFERENCES users(id) ON DELETE CASCADE');
    }
  });

  // Edits before 039 overwrote their text: there is nothing to backfill.
  it('starts the history empty, with both timestamps of every version', () => {
    expect(migration).not.toMatch(/INSERT INTO (post|comment)_revisions/);
    expect(migration).toContain('version_at TIMESTAMP NOT NULL');
    expect(migration).toContain(
      'replaced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    );
  });

  it('indexes the vote listings by account, kind and direction', () => {
    expect(migration).toContain(
      'CREATE INDEX idx_votes_user_value ON votes (user_id, target_type, value, created_at, id);',
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
