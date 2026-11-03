import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 022 (community deletion)', () => {
  const migration = read(
    '../../../../data/migrations/022_add_community_deletion.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  it('adds both columns, the foreign key, the check and the index, and nothing else', () => {
    expect(sql).toBe(
      'ALTER TABLE communities ' +
        'ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL, ' +
        'ADD COLUMN deleted_by VARCHAR(36) NULL, ' +
        'ADD CONSTRAINT fk_communities_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL, ' +
        'ADD CONSTRAINT chk_communities_deletion CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR deleted_at IS NOT NULL); ' +
        'CREATE INDEX idx_communities_deleted_at ON communities (deleted_at);',
    );
  });

  it('states re-run safety and that no content is destroyed', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application/,
    );
    expect(migration).toMatch(/not destroyed/);
  });

  it('is mirrored in the snapshot and records the version', () => {
    const communities = normalise(
      /CREATE TABLE communities \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    expect(communities).toContain('deleted_at TIMESTAMP NULL DEFAULT NULL');
    expect(communities).toContain('deleted_by VARCHAR(36) NULL');
    expect(communities).toContain(
      'CONSTRAINT fk_communities_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(communities).toContain(
      'CONSTRAINT chk_communities_deletion CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR deleted_at IS NOT NULL)',
    );
    expect(snapshot).toContain(
      'CREATE INDEX idx_communities_deleted_at ON communities (deleted_at);',
    );
    expect(normalise(snapshot)).toContain("('022_add_community_deletion')");
  });
});
