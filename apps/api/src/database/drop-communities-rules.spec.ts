import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// The documented pre-drop verification query, taken from README.md.
function readmeVerificationQuery(): string {
  const readme = read('../../README.md');
  const section = readme.slice(readme.indexOf('**Pre-drop verification.**'));
  const query = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
  if (!query) {
    throw new Error('Pre-drop verification query not found in README.md');
  }
  return query;
}

describe('migration 014 (drop communities.rules)', () => {
  const drop = read(
    '../../../../data/migrations/014_drop_communities_rules.sql',
  );

  it('guards the drop with exactly the documented verification query', () => {
    const query = normalise(readmeVerificationQuery());
    expect(
      query.startsWith('SELECT COUNT(*) AS unmigrated FROM communities c'),
    ).toBe(true);

    const predicate = query.replace('SELECT COUNT(*) AS unmigrated ', '');
    expect(normalise(drop)).toContain(
      `INSERT INTO communities_rules_drop_guard (unmigrated) SELECT COUNT(*) ${predicate};`,
    );
  });

  it('runs the guard and its CHECK before the irreversible ALTER', () => {
    const sql = normalise(drop.replace(/^--.*$/gm, ''));
    const check = sql.indexOf('CHECK (unmigrated = 0)');
    const guard = sql.indexOf('INSERT INTO communities_rules_drop_guard');
    const alter = sql.indexOf('ALTER TABLE communities DROP COLUMN rules;');

    expect(check).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(check);
    expect(alter).toBeGreaterThan(guard);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it('states irreversibility, ordering and re-run safety in its header', () => {
    expect(drop).toMatch(/IRREVERSIBLE/);
    expect(drop).toMatch(/must run after 009 \(initial backfill\) and 013/);
    expect(drop).toMatch(/Not re-runnable after success/);
  });

  it('is reflected in the full-install snapshot', () => {
    const snapshot = read('../../../../data/community.sql');
    const communities = /CREATE TABLE communities \(([\s\S]*?)\n\);/.exec(
      snapshot,
    )?.[1];

    expect(communities).toBeDefined();
    expect(communities).not.toMatch(/\brules\b/);
    expect(snapshot).toContain("('013_backfill_late_community_rules')");
    expect(snapshot).toContain("('014_drop_communities_rules');");
  });
});
