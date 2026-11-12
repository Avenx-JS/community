import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNITY_REPORT_STATUSES } from '../reports/community-report-review';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 036 (community report review)', () => {
  const file = read(
    '../../../../data/migrations/036_add_community_report_review.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  const table =
    /CREATE TABLE user_reports \(([^;]*)\);/.exec(snapshot)?.[1] ?? '';

  it('adds the community level beside the administrators’ status', () => {
    for (const column of [
      'community_id VARCHAR(36) NULL',
      `community_status ENUM(${COMMUNITY_REPORT_STATUSES.map((s) => `'${s}'`).join(', ')}) NULL`,
      'community_reviewed_by VARCHAR(36) NULL',
      'community_reviewed_at TIMESTAMP NULL DEFAULT NULL',
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
      expect(table).toContain(column);
    }
    // The administrators' columns are untouched.
    expect(migration).not.toMatch(/MODIFY COLUMN status|DROP COLUMN/);
  });

  it('keeps every new reference ON DELETE SET NULL: a report outlives what it is about', () => {
    for (const fk of [
      'fk_user_reports_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL',
      'fk_user_reports_community_reviewed_by FOREIGN KEY (community_reviewed_by) REFERENCES users(id) ON DELETE SET NULL',
    ]) {
      expect(migration).toContain(fk);
      expect(table).toContain(fk.replace(' FOREIGN KEY', ' FOREIGN KEY'));
    }
  });

  it('declares the two queue indexes in both', () => {
    expect(migration).toContain(
      'CREATE INDEX idx_user_reports_modqueue ON user_reports (community_id, community_status, target_type, target_id);',
    );
    expect(migration).toContain(
      'CREATE INDEX idx_user_reports_community ON user_reports (community_id, community_status, created_at);',
    );
    expect(table).toContain(
      'INDEX idx_user_reports_modqueue (community_id, community_status, target_type, target_id)',
    );
    expect(table).toContain(
      'INDEX idx_user_reports_community (community_id, community_status, created_at)',
    );
  });

  // Reports already decided or withdrawn must not flood the new queue.
  it('backfills communities for content reports, and opens only those still open for administrators', () => {
    expect(migration).toContain(
      "UPDATE user_reports JOIN posts ON user_reports.target_type = 'post' AND posts.id = user_reports.target_id SET user_reports.community_id = posts.community_id;",
    );
    expect(migration).toContain(
      "UPDATE user_reports SET community_status = 'open' WHERE community_id IS NOT NULL AND status IN ('open', 'under_review') AND withdrawn_at IS NULL;",
    );
  });

  it('records the version and states re-run safety', () => {
    expect(snapshot).toContain(
      "('035_create_media'), ('036_add_community_report_review')",
    );
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
