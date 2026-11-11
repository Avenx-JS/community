import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 035 (media)', () => {
  const file = read('../../../../data/migrations/035_create_media.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  // The snapshot appends the migration's statements verbatim, so a fresh
  // installation and an upgraded one have the same columns, keys and order.
  it('is in the snapshot verbatim, with its version recorded', () => {
    expect(snapshot).toContain(migration);
    expect(snapshot).toContain(
      "('034_add_content_ranking'), ('035_create_media');",
    );
  });

  it('keeps every reference RESTRICT, so the sweep cannot delete a file in use', () => {
    for (const fk of [
      'fk_posts_media FOREIGN KEY (media_id) REFERENCES media(id);',
      'fk_users_avatar_media FOREIGN KEY (avatar_media_id) REFERENCES media(id);',
      'fk_communities_icon_media FOREIGN KEY (icon_media_id) REFERENCES media(id),',
      'fk_communities_banner_media FOREIGN KEY (banner_media_id) REFERENCES media(id);',
    ]) {
      expect(migration).toContain(fk);
    }
    expect(migration).not.toMatch(/REFERENCES media\(id\) ON DELETE/);
  });

  it('makes each reference unique: one file serves one place', () => {
    for (const unique of [
      'uq_posts_media_id UNIQUE (media_id)',
      'uq_users_avatar_media_id UNIQUE (avatar_media_id)',
      'uq_communities_icon_media_id UNIQUE (icon_media_id)',
      'uq_communities_banner_media_id UNIQUE (banner_media_id)',
    ]) {
      expect(migration).toContain(unique);
    }
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
