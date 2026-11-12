import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 038 (community settings)', () => {
  const file = read(
    '../../../../data/migrations/038_add_community_settings.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  // Everything but the enum rewrite, which the snapshot holds in the table.
  const appended = migration.slice(
    0,
    migration.indexOf('ALTER TABLE community_moderation_actions'),
  );

  it('is in the snapshot verbatim, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Community settings (038_add_community_settings). ${appended}`,
    );
    expect(snapshot).toContain(
      "('037_add_account_settings'), ('038_add_community_settings');",
    );
  });

  // Existing communities keep behaving exactly as before.
  it('defaults every existing community to public, safe for work and all post types', () => {
    expect(migration).toContain(
      "ADD COLUMN visibility ENUM('public', 'restricted', 'private') NOT NULL DEFAULT 'public'",
    );
    expect(migration).toContain(
      'ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT FALSE',
    );
    expect(migration).toContain(
      "ADD COLUMN allowed_post_types SET('text', 'link', 'media') NOT NULL DEFAULT 'text,link,media'",
    );
    expect(migration).not.toMatch(/UPDATE communities/);
  });

  it('cascades every new table from users and communities', () => {
    for (const table of [
      'community_join_requests',
      'community_moderator_invites',
      'community_user_flairs',
      'community_mutes',
    ]) {
      const body = new RegExp(`CREATE TABLE ${table} \\(([^;]*)\\);`).exec(
        migration,
      )?.[1];
      expect(body).toContain(
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      );
      expect(body).toContain(
        'FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE',
      );
    }
  });

  // A deleted flair disappears from posts but never deletes one.
  it('clears a deleted flair from posts and removes it from members', () => {
    expect(migration).toContain(
      'ADD CONSTRAINT fk_posts_flair FOREIGN KEY (flair_id) REFERENCES community_flairs(id) ON DELETE SET NULL',
    );
    expect(migration).toContain(
      'FOREIGN KEY (flair_id) REFERENCES community_flairs(id) ON DELETE CASCADE',
    );
  });

  // One request and one invitation per account and community.
  it('keys requests and invitations by community and account', () => {
    expect(migration).toMatch(
      /CREATE TABLE community_join_requests \([^;]*PRIMARY KEY \(community_id, user_id\)/,
    );
    expect(migration).toMatch(
      /CREATE TABLE community_moderator_invites \([^;]*PRIMARY KEY \(community_id, user_id\)/,
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
