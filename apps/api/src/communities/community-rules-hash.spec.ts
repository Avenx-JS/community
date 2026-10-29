import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalizeCommunityRules,
  hashCommunityRules,
} from './community-rules-hash';

describe('canonicalizeCommunityRules', () => {
  it('serialises items by position with byte-length prefixes', () => {
    expect(
      canonicalizeCommunityRules([
        { position: 2, title: 'Grüße', body: 'a\nb' },
        { position: 1, title: 'Be kind', body: null },
      ]),
    ).toBe('1\n7:Be kind\n0:\n2\n7:Grüße\n3:a\nb');
  });

  it('rejects duplicate and non-positive positions', () => {
    expect(() =>
      canonicalizeCommunityRules([
        { position: 1, title: 'A', body: null },
        { position: 1, title: 'B', body: null },
      ]),
    ).toThrow('Duplicate rule position: 1');
    expect(() =>
      canonicalizeCommunityRules([{ position: 0, title: 'A', body: null }]),
    ).toThrow('Invalid rule position: 0');
  });
});

describe('hashCommunityRules', () => {
  const first = { position: 1, title: 'Be kind', body: 'No insults.' };
  const second = { position: 2, title: 'No spam', body: null };

  it('returns a lowercase SHA-256 hex digest', () => {
    expect(hashCommunityRules([first])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on rule positions, not on input array order', () => {
    expect(hashCommunityRules([second, first])).toBe(
      hashCommunityRules([first, second]),
    );
    expect(
      hashCommunityRules([
        { ...first, position: 2 },
        { ...second, position: 1 },
      ]),
    ).not.toBe(hashCommunityRules([first, second]));
  });

  it('treats a null body as an empty body', () => {
    expect(hashCommunityRules([{ ...first, body: null }])).toBe(
      hashCommunityRules([{ ...first, body: '' }]),
    );
  });

  it('hashes whitespace-only input verbatim without normalising it', () => {
    expect(hashCommunityRules([{ ...first, body: '  \n' }])).not.toBe(
      hashCommunityRules([{ ...first, body: null }]),
    );
    expect(hashCommunityRules([{ ...first, title: ' ' }])).not.toBe(
      hashCommunityRules([{ ...first, title: '' }]),
    );
  });

  it('distinguishes one rule containing line breaks from two rules', () => {
    expect(
      hashCommunityRules([
        { position: 1, title: 'A', body: 'x' },
        { position: 2, title: 'B', body: 'y' },
      ]),
    ).not.toBe(
      hashCommunityRules([{ position: 1, title: 'A', body: 'x\n2\n1:B\n1:y' }]),
    );
  });
});

describe('migration 009 backfill hash', () => {
  // The backfill computes content_hash with this SQL expression. The expected
  // digest below was produced by MySQL 8.0 evaluating it over the fixture:
  //   SET @rules = CONVERT(X'<fixture as UTF-8 hex>' USING utf8mb4);
  //   SELECT SHA2(CONCAT(... with c.rules replaced by @rules ...), 256);
  const backfillHashExpression = [
    'SHA2(CONCAT(',
    "'1', CHAR(10 USING utf8mb4),",
    "LENGTH('Community rules'), ':', 'Community rules', CHAR(10 USING utf8mb4),",
    "LENGTH(CONVERT(c.rules USING utf8mb4)), ':', CONVERT(c.rules USING utf8mb4)",
    '), 256)',
  ].join(' ');
  const legacyRules = 'Be kind.\n\nNo spam — ever. Grüße 🎉\n';
  const mysqlDigest =
    '5caa4dbf1c4933a85604c7daf488685690286cc31c2f581a2590216038e579d4';

  it('uses the expression the fixture digest was produced with', () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../../data/migrations/009_create_community_rule_documents.sql',
      ),
      'utf8',
    );

    expect(migration.replace(/\s+/g, ' ')).toContain(backfillHashExpression);
  });

  it('matches the application hash for a backfilled community', () => {
    expect(
      hashCommunityRules([
        { position: 1, title: 'Community rules', body: legacyRules },
      ]),
    ).toBe(mysqlDigest);
  });
});
