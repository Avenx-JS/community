import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { USER_ID_BY_USERNAME_SQL } from './user-activity.service';
import {
  BLOCK_STATE_SQL,
  BLOCK_USER_SQL,
  BLOCKED_USERS_COUNT_SQL,
  BLOCKED_USERS_FROM,
  BLOCKED_USERS_SQL,
  LOCK_BLOCKED_SQL,
  LOCK_BLOCKER_SQL,
  UNBLOCK_USER_SQL,
  UserBlocksService,
} from './user-blocks.service';

type Query = { sql: string; values: unknown[] };

describe('UserBlocksService', () => {
  let queries: Query[];
  let results: unknown[];
  let log: string[];

  const service = (max?: string) => {
    if (max === undefined) {
      delete process.env.USER_BLOCKS_MAX;
    } else {
      process.env.USER_BLOCKS_MAX = max;
    }
    const execute = (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve([results.shift() ?? [], []]);
    };
    const connection = {
      execute,
      beginTransaction: () => {
        log.push('begin');
        return Promise.resolve();
      },
      commit: () => {
        log.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        log.push('rollback');
        return Promise.resolve();
      },
      release: () => log.push('release'),
    };
    return new UserBlocksService({
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool);
  };

  beforeEach(() => {
    queries = [];
    results = [];
    log = [];
  });

  afterEach(() => {
    delete process.env.USER_BLOCKS_MAX;
  });

  const alive = [{ deleted_at: null }];
  const state = (total: number, alreadyBlocked = 0) => [
    { total, already_blocked: alreadyBlocked },
  ];

  describe('block', () => {
    it('resolves the username, locks both users, counts, then upserts in one transaction', async () => {
      results = [[{ id: 'u-target' }], alive, alive, state(0), {}];

      await service().block('target', 'u-caller');

      expect(queries).toEqual([
        { sql: USER_ID_BY_USERNAME_SQL, values: ['target'] },
        { sql: LOCK_BLOCKER_SQL, values: ['u-caller'] },
        { sql: LOCK_BLOCKED_SQL, values: ['u-target'] },
        { sql: BLOCK_STATE_SQL, values: ['u-target', 'u-caller'] },
        { sql: BLOCK_USER_SQL, values: ['u-caller', 'u-target'] },
      ]);
      expect(log).toEqual(['begin', 'commit', 'release']);
    });

    // A repeat block keeps one row and its created_at: the listing order key.
    it('is an idempotent upsert that never refreshes created_at', () => {
      expect(BLOCK_USER_SQL).toBe(
        'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at',
      );
    });

    it('binds the blocker to the caller, never to anything in the request', async () => {
      results = [[{ id: 'u-target' }], alive, alive, state(0), {}];
      await service().block('u-spoofed', 'u-caller');
      const insert = queries.find(({ sql }) => sql === BLOCK_USER_SQL)!;
      expect(insert.values[0]).toBe('u-caller');
    });

    it('answers 404 for an unknown or deleted username, opening no transaction', async () => {
      results = [[]];
      await expect(
        service().block('nobody', 'u-caller'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
      expect(USER_ID_BY_USERNAME_SQL).toContain('deleted_at IS NULL');
      expect(log).toEqual([]);
    });

    it('answers 400 for your own account, with the message, writing nothing', async () => {
      results = [[{ id: 'u-caller' }]];
      const attempt = service().block('caller', 'u-caller');
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('You cannot block yourself');
      expect(queries).toHaveLength(1);
      expect(log).toEqual([]);
    });

    // Otherwise the row would outlive the deletion that just removed its peers.
    it('answers 404 and rolls back if the target was deleted after the lookup', async () => {
      results = [
        [{ id: 'u-target' }],
        alive,
        [{ deleted_at: new Date('2026-11-01T00:00:00.000Z') }],
      ];
      await expect(
        service().block('target', 'u-caller'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries.some(({ sql }) => sql === BLOCK_USER_SQL)).toBe(false);
      expect(log).toEqual(['begin', 'rollback', 'release']);
    });

    // A blocks B while B blocks A: locking each request's own blocker first
    // would deadlock on the insert's foreign-key checks.
    it.each([
      ['a-caller', 'b-target', [LOCK_BLOCKER_SQL, LOCK_BLOCKED_SQL]],
      ['z-caller', 'b-target', [LOCK_BLOCKED_SQL, LOCK_BLOCKER_SQL]],
    ])(
      'locks the users rows in id order: %s blocking %s',
      async (caller, target, order) => {
        results = [[{ id: target }], alive, alive, state(0), {}];
        await service().block('target', caller);
        expect(queries.slice(1, 3)).toEqual([
          { sql: order[0], values: [[caller, target].sort()[0]] },
          { sql: order[1], values: [[caller, target].sort()[1]] },
        ]);
      },
    );

    describe('the cap', () => {
      it('defaults to 1000', async () => {
        results = [[{ id: 'u-target' }], alive, alive, state(999), {}];
        await service().block('target', 'u-caller');
        expect(queries.at(-1)?.sql).toBe(BLOCK_USER_SQL);

        queries = [];
        results = [[{ id: 'u-target' }], alive, alive, state(1000)];
        await expect(service().block('target', 'u-caller')).rejects.toThrow(
          'You can block at most 1000 accounts',
        );
      });

      it('counts inside the transaction with a locking read, answering 409 and writing nothing', async () => {
        results = [[{ id: 'u-target' }], alive, alive, state(2)];
        await expect(
          service('2').block('target', 'u-caller'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(BLOCK_STATE_SQL).toMatch(/FOR SHARE$/);
        expect(queries.some(({ sql }) => sql === BLOCK_USER_SQL)).toBe(false);
        expect(log).toEqual(['begin', 'rollback', 'release']);
      });

      it('does not refuse a repeat block at the cap: it adds no row', async () => {
        results = [[{ id: 'u-target' }], alive, alive, state(2, 1), {}];
        await expect(
          service('2').block('target', 'u-caller'),
        ).resolves.toBeUndefined();
        expect(queries.at(-1)?.sql).toBe(BLOCK_USER_SQL);
      });

      it('refuses an invalid USER_BLOCKS_MAX at startup', () => {
        expect(() => service('many')).toThrow('USER_BLOCKS_MAX');
      });
    });

    // Models what InnoDB does for this flow: row locks are held to the end of
    // the transaction and a transaction cannot see another's uncommitted
    // insert. Without the lock on the blocker, both requests would count the
    // same committed rows and both would pass.
    describe('two concurrent blocks at the cap', () => {
      const database = (committed: string[], onCount: () => void) => {
        const locks = new Map<string, Promise<void>>();
        const rows = [...committed];
        let counted = false;

        const getConnection = () => {
          const held: (() => void)[] = [];
          const pending: string[] = [];
          const finish = () => {
            pending.length = 0;
            held.splice(0).forEach((release) => release());
            return Promise.resolve();
          };
          return Promise.resolve({
            beginTransaction: () => Promise.resolve(),
            commit: () => {
              rows.push(...pending);
              return finish();
            },
            rollback: finish,
            release: () => undefined,
            execute: async (sql: string, values: string[]) => {
              if (sql === LOCK_BLOCKER_SQL || sql === LOCK_BLOCKED_SQL) {
                const [id] = values;
                const previous = locks.get(id) ?? Promise.resolve();
                let release!: () => void;
                locks.set(
                  id,
                  new Promise<void>((resolve) => {
                    release = resolve;
                  }),
                );
                held.push(release);
                await previous;
                return [[{ deleted_at: null }], []];
              }
              if (sql === BLOCK_STATE_SQL) {
                const result = [
                  [{ total: rows.length, already_blocked: 0 }],
                  [],
                ];
                if (!counted) {
                  // The competing request starts between this count and the
                  // first request's insert.
                  counted = true;
                  onCount();
                }
                return result;
              }
              if (sql === BLOCK_USER_SQL) {
                pending.push(values[1]);
                return [{}, []];
              }
              throw new Error(`Unexpected SQL: ${sql}`);
            },
          });
        };
        return {
          rows,
          pool: {
            getConnection,
            execute: (_sql: string, values: string[]) =>
              Promise.resolve([[{ id: `id-${values[0]}` }], []]),
          } as unknown as Pool,
        };
      };

      it('lets the first through and answers the second with 409', async () => {
        process.env.USER_BLOCKS_MAX = '2';
        let competing: Promise<void> | undefined;
        const db = database(['existing'], () => {
          competing = blocks.block('second', 'u-caller');
        });
        const blocks = new UserBlocksService(db.pool);

        await expect(
          blocks.block('first', 'u-caller'),
        ).resolves.toBeUndefined();
        await expect(competing).rejects.toBeInstanceOf(ConflictException);
        expect(db.rows).toEqual(['existing', 'id-first']);
      });
    });
  });

  describe('unblock', () => {
    it('resolves the username, then deletes only the caller’s row', async () => {
      results = [[{ id: 'u-target' }], { affectedRows: 1 }];
      await service().unblock('target', 'u-caller');
      expect(queries).toEqual([
        { sql: USER_ID_BY_USERNAME_SQL, values: ['target'] },
        { sql: UNBLOCK_USER_SQL, values: ['u-caller', 'u-target'] },
      ]);
    });

    it('is idempotent: removing a block that does not exist still succeeds', async () => {
      results = [[{ id: 'u-target' }], { affectedRows: 0 }];
      await expect(
        service().unblock('target', 'u-caller'),
      ).resolves.toBeUndefined();
    });

    it('answers 404 for an unknown user, deleting nothing', async () => {
      results = [[]];
      await expect(
        service().unblock('nobody', 'u-caller'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('lists the caller’s blocks newest first, with only the documented fields', async () => {
      results = [
        [
          {
            username: 'newer',
            display_name: 'Newer',
            blocked_at: new Date('2026-11-02T08:00:00.000Z'),
            // Planted: must not be copied across.
            email: 'leak@example.test',
            id: 'u-newer',
          },
          {
            username: 'older',
            display_name: null,
            blocked_at: new Date('2026-11-01T08:00:00.000Z'),
          },
        ],
        [{ total: '2' }],
      ];

      await expect(service().list('u-caller', {})).resolves.toEqual({
        items: [
          {
            username: 'newer',
            display_name: 'Newer',
            blocked_at: '2026-11-02T08:00:00.000Z',
          },
          {
            username: 'older',
            display_name: null,
            blocked_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        page: 1,
        limit: 20,
        total: 2,
      });
      expect(queries).toEqual([
        { sql: BLOCKED_USERS_SQL, values: ['u-caller', 20, 0] },
        { sql: BLOCKED_USERS_COUNT_SQL, values: ['u-caller'] },
      ]);
      expect(BLOCKED_USERS_SQL).toContain(
        'ORDER BY b.created_at DESC, b.blocked_id DESC',
      );
    });

    it.each([
      { page: 1, limit: 20, offset: 0 },
      { page: 3, limit: 7, offset: 14 },
      { page: 10000, limit: 100, offset: 999900 },
    ])('pages with LIMIT/OFFSET for %o', async ({ page, limit, offset }) => {
      results = [[], [{ total: 0 }]];
      const result = await service().list('u-caller', { page, limit });
      expect(queries[0].values).toEqual(['u-caller', limit, offset]);
      expect(result).toMatchObject({ page, limit });
    });

    it('answers an account without blocks with an empty page', async () => {
      results = [[], [{ total: 0 }]];
      await expect(service().list('u-caller', {})).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    });

    it('omits deleted accounts, counting the same way as the page', () => {
      expect(BLOCKED_USERS_FROM).toContain('u.deleted_at IS NULL');
      expect(BLOCKED_USERS_SQL).toContain(BLOCKED_USERS_FROM);
      expect(BLOCKED_USERS_COUNT_SQL).toBe(
        `SELECT COUNT(*) AS total ${BLOCKED_USERS_FROM}`,
      );
    });

    it('never selects an id, an email or a credential', () => {
      const [selected] = BLOCKED_USERS_SQL.split('FROM');
      expect(selected).toBe(
        'SELECT u.username, u.display_name, b.created_at AS blocked_at\n       ',
      );
    });
  });
});
