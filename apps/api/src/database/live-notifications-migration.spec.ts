import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 040 (live notifications)', () => {
  const file = read(
    '../../../../data/migrations/040_add_live_notifications.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  const body = (table: string) =>
    migration.split(`CREATE TABLE ${table} (`)[1]?.split(';')[0] ?? '';

  it('is in the snapshot verbatim, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Live notifications: push subscriptions, stream tickets and push dispatch (040_add_live_notifications). ${migration}`,
    );
    expect(snapshot).toContain(
      "('039_add_content_labels_and_history'), ('040_add_live_notifications'),",
    );
  });

  // Turning push on must never send the existing inbox.
  it('marks every existing notification dispatched, so no backlog is pushed', () => {
    expect(migration).toContain(
      'ADD COLUMN push_dispatched_at TIMESTAMP NULL DEFAULT NULL',
    );
    expect(migration).toContain(
      'UPDATE notifications SET push_dispatched_at = created_at WHERE push_dispatched_at IS NULL;',
    );
    expect(migration).toContain(
      'ADD INDEX idx_notifications_push_pending (push_dispatched_at, created_at)',
    );
  });

  it('stores a subscription once per endpoint, by hash, and goes with the account', () => {
    expect(body('push_subscriptions')).toContain(
      'UNIQUE KEY uq_push_subscriptions_endpoint (endpoint_hash)',
    );
    expect(body('push_subscriptions')).toContain(
      'endpoint_hash CHAR(64) NOT NULL',
    );
    expect(body('push_subscriptions')).toContain(
      'REFERENCES users(id) ON DELETE CASCADE',
    );
  });

  // A ticket is a credential: only its hash is stored.
  it('stores stream tickets as hashes, bound to the minting session', () => {
    expect(body('notification_stream_tickets')).toContain(
      'ticket_hash CHAR(64) PRIMARY KEY',
    );
    expect(body('notification_stream_tickets')).toContain(
      'token_hash CHAR(64) NOT NULL',
    );
    expect(migration).not.toMatch(/\bticket VARCHAR|\btoken VARCHAR/);
  });

  it('defaults the push preference on, as the other notification defaults', () => {
    expect(migration).toContain(
      'ALTER TABLE user_preferences ADD COLUMN push_notifications BOOLEAN NOT NULL DEFAULT TRUE;',
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
