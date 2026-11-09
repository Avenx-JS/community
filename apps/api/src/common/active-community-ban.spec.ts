import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ACTIVE_COMMUNITY_BAN_PREDICATE,
  ACTIVE_COMMUNITY_BAN_SQL,
} from './active-community-ban';

const SRC = resolve(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('ACTIVE_COMMUNITY_BAN_PREDICATE', () => {
  it('is in force when not lifted and permanent or not yet expired', () => {
    expect(ACTIVE_COMMUNITY_BAN_PREDICATE).toBe(
      'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())',
    );
  });

  it('is the condition of the active-ban lookup', () => {
    expect(ACTIVE_COMMUNITY_BAN_SQL.replace(/\s+/g, ' ')).toBe(
      `SELECT id FROM community_bans WHERE community_id = ? AND user_id = ? AND ${ACTIVE_COMMUNITY_BAN_PREDICATE} LIMIT 1`,
    );
  });

  // One definition, so the ban routes and enforcement cannot disagree about
  // who is banned. (Sessions and restrictions have expiry checks of their own
  // shape, for their own tables.)
  it('is restated nowhere in the source that reads community_bans', () => {
    const readers = sourceFiles(SRC).filter((path) =>
      readFileSync(path, 'utf8').includes('community_bans'),
    );
    expect(readers.length).toBeGreaterThan(1);
    const restating = readers
      .filter((path) => /expires_at\s*>/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).replace(/\\/g, '/'));
    expect(restating).toEqual(['common/active-community-ban.ts']);
  });
});
