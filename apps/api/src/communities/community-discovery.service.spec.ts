import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { COMMUNITY_ROLE_BY_NAME_SQL } from './community-access';
import {
  CommunityDiscoveryService,
  MUTE_COMMUNITY_SQL,
  POPULAR_COMMUNITIES_SQL,
  RECOMMENDED_COMMUNITIES_SQL,
  TRENDING_COMMUNITIES_SQL,
  UNMUTE_COMMUNITY_SQL,
} from './community-discovery.service';

const row = (id: string, activity = 0) => ({
  id,
  creator_id: 'creator',
  name: id,
  description: null,
  created_at: new Date('2026-11-01T00:00:00Z'),
  visibility: 'public',
  nsfw: 0,
  allowed_post_types: 'text,link,media',
  activity,
  new_members: '2',
});

function harness(answers: Map<string, unknown[]>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    execute: (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL)) {
        return Promise.resolve([
          [
            {
              id: 'c-1',
              name: 'garden',
              creator_id: 'x',
              visibility: 'public',
              can_moderate: 0,
            },
          ],
          [],
        ]);
      }
      return Promise.resolve([answers.get(sql) ?? [], []]);
    },
  } as unknown as Pool;
  return { statements, service: new CommunityDiscoveryService(pool) };
}

describe('CommunityDiscoveryService', () => {
  it('ranks trending communities from recent activity, never private ones', async () => {
    const { service, statements } = harness(
      new Map([[TRENDING_COMMUNITIES_SQL, [row('a', 5)]]]),
    );
    await expect(service.trending({ limit: 5 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: 'a',
          visibility: 'public',
          activity: 5,
          new_members: 2,
        }),
      ],
    });
    expect(statements[0].values).toEqual([null, 5]);
    expect(TRENDING_COMMUNITIES_SQL).toContain("c.visibility <> 'private'");
    expect(TRENDING_COMMUNITIES_SQL).toContain('INTERVAL 1 DAY');
    expect(TRENDING_COMMUNITIES_SQL).toContain('INTERVAL 7 DAY');
    expect(TRENDING_COMMUNITIES_SQL).toContain('viewer_preferences.show_nsfw');
    expect(TRENDING_COMMUNITIES_SQL).toContain('community_mutes viewer_mute');
  });

  it('recommends by fellow members, bounded, then fills with popular ones without repeats', async () => {
    const { service, statements } = harness(
      new Map([
        [RECOMMENDED_COMMUNITIES_SQL, [row('a', 3)]],
        [POPULAR_COMMUNITIES_SQL, [row('a'), row('b'), row('c')]],
      ]),
    );
    const { items } = await service.recommended({ limit: 2 }, 'sam');
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(statements[0].values).toEqual(['sam', 1000, 'sam', 'sam', 2]);
    expect(statements[1].values).toEqual(['sam', 'sam', 2]);
    for (const sql of [RECOMMENDED_COMMUNITIES_SQL, POPULAR_COMMUNITIES_SQL]) {
      expect(sql).toContain('WHERE NOT (c.creator_id = viewer.id');
      expect(sql).toContain("c.visibility <> 'private'");
    }
  });

  it('skips the fallback when fellow members fill the page', async () => {
    const { service, statements } = harness(
      new Map([[RECOMMENDED_COMMUNITIES_SQL, [row('a'), row('b')]]]),
    );
    await service.recommended({ limit: 2 }, 'sam');
    expect(statements).toHaveLength(1);
  });

  it('mutes and unmutes idempotently by community id', async () => {
    const { service, statements } = harness(new Map());
    await service.mute('garden', 'sam');
    await service.unmute('garden', 'sam');
    expect(
      statements.filter(
        ({ sql }) => !sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL),
      ),
    ).toEqual([
      { sql: MUTE_COMMUNITY_SQL, values: ['sam', 'c-1'] },
      { sql: UNMUTE_COMMUNITY_SQL, values: ['sam', 'c-1'] },
    ]);
    expect(MUTE_COMMUNITY_SQL).toMatch(/^INSERT IGNORE/);
  });
});
