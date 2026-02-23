import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';

import { runGdprErasure } from '../scripts/gdpr-erasure';

type TestClient = {
  connect: () => Promise<void>;
  end: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

async function createClient(): Promise<TestClient> {
  const db = newDb();

  db.public.none(`
    CREATE TABLE users (
      tiktok_user_id TEXT PRIMARY KEY,
      unique_id TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      meta JSONB NOT NULL DEFAULT '{}'
    );
  `);

  db.public.none(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT,
      event_data JSONB NOT NULL
    );
  `);

  db.public.none(`
    CREATE TABLE actions_log (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      stream_id TEXT,
      session_id TEXT,
      rendered_template TEXT,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      meta JSONB NOT NULL DEFAULT '{}'
    );
  `);

  const { Client } = db.adapters.createPg();
  const client: TestClient = new Client();
  await client.connect();
  return client;
}

test('runGdprErasure pseudonymizes user, scrubs event payload, and logs audit row', async () => {
  const client = await createClient();

  try {
    await client.query(
      `INSERT INTO users (tiktok_user_id, unique_id, display_name, avatar_url, meta)
       VALUES ('111', 'alice', 'Alice', 'https://example.com/alice.png', '{}'::jsonb)`
    );

    await client.query(
      `INSERT INTO events (event_id, user_id, event_data)
       VALUES
        ('evt-1', '111', $1::jsonb),
        ('evt-2', NULL, $2::jsonb),
        ('evt-3', '999', $3::jsonb)`,
      [
        JSON.stringify({
          user: {
            userId: '111',
            uniqueId: 'alice',
            displayName: 'Alice',
            avatarUrl: 'https://example.com/alice.png',
          },
          payload: { message: 'hello world', coins: 10 },
        }),
        JSON.stringify({
          user: {
            userId: '111',
            uniqueId: 'alice',
            displayName: 'Alice',
          },
          payload: { message: 'second event' },
        }),
        JSON.stringify({
          user: {
            userId: '999',
            uniqueId: 'other',
            displayName: 'Other User',
          },
          payload: { message: 'leave me alone' },
        }),
      ]
    );

    const summary = await runGdprErasure(client, {
      userId: '111',
      auditRuleId: 'rule-gdpr-erasure',
      now: new Date('2026-02-23T12:00:00.000Z'),
    });

    assert.equal(summary.rowsAffected.events, 2);
    assert.equal(summary.rowsAffected.users, 1);
    assert.equal(summary.rowsAffected.actionsLog, 1);
    assert.equal(summary.target, 'userId');

    const oldUser = await client.query(
      'SELECT * FROM users WHERE tiktok_user_id = $1',
      ['111']
    );
    assert.equal(oldUser.rowCount, 0);

    const anonymizedUser = await client.query(
      'SELECT * FROM users WHERE tiktok_user_id = $1',
      [summary.pseudonymizedUserId]
    );
    assert.equal(anonymizedUser.rowCount, 1);
    assert.notEqual(anonymizedUser.rows[0].unique_id, 'alice');
    assert.notEqual(anonymizedUser.rows[0].display_name, 'Alice');
    assert.notEqual(anonymizedUser.rows[0].avatar_url, 'https://example.com/alice.png');

    const updatedEvents = await client.query(
      `SELECT event_id, user_id, event_data
       FROM events
       WHERE event_id IN ('evt-1', 'evt-2')
       ORDER BY event_id ASC`
    );

    assert.equal(updatedEvents.rowCount, 2);

    for (const row of updatedEvents.rows) {
      assert.equal(row.user_id, summary.pseudonymizedUserId);
      const data = row.event_data as Record<string, unknown>;
      const user = data.user as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown>;

      assert.equal(user.userId, summary.pseudonymizedUserId);
      assert.equal(user.uniqueId, summary.pseudonymizedUniqueId);
      assert.equal(user.displayName, '[erased]');
      if ('avatarUrl' in user) {
        assert.equal(user.avatarUrl, null);
      }
      assert.equal(payload.message, '[erased]');
    }

    const untouchedEvent = await client.query(
      'SELECT event_data FROM events WHERE event_id = $1',
      ['evt-3']
    );
    const untouchedPayload = untouchedEvent.rows[0].event_data as Record<string, unknown>;
    const untouchedUser = untouchedPayload.user as Record<string, unknown>;
    assert.equal(untouchedUser.userId, '999');

    const auditRow = await client.query(
      `SELECT event_id, status, meta
       FROM actions_log
       WHERE rule_id = $1`,
      ['rule-gdpr-erasure']
    );

    assert.equal(auditRow.rowCount, 1);
    assert.equal(auditRow.rows[0].status, 'success');
    const auditMeta = auditRow.rows[0].meta as Record<string, unknown>;
    assert.equal(auditMeta.operation, 'gdpr-erasure');
  } finally {
    await client.end();
  }
});

test('runGdprErasure issues ROLLBACK and does not COMMIT when audit insert fails', async () => {
  const calls: string[] = [];

  const failingDb = {
    async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
      calls.push(sql.trim());

      if (sql.startsWith('SELECT tiktok_user_id')) {
        return {
          rows: [{ tiktok_user_id: '222', unique_id: 'bob' }],
          rowCount: 1,
        };
      }

      if (sql.startsWith('SELECT event_id')) {
        return {
          rows: [
            {
              event_id: 'evt-fail',
              event_data: {
                user: { userId: '222', uniqueId: 'bob', displayName: 'Bob', avatarUrl: 'https://example.com/bob.png' },
                payload: { message: 'should rollback' },
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.startsWith('UPDATE events')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE users')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('INSERT INTO actions_log')) {
        throw new Error('actions_log insert failed');
      }

      return { rows: [], rowCount: 0 };
    },
  };

  await assert.rejects(
    () =>
      runGdprErasure(failingDb, {
        userId: '222',
        auditRuleId: 'rule-gdpr-erasure',
        now: new Date('2026-02-23T12:00:00.000Z'),
      }),
    /actions_log insert failed/
  );

  assert.equal(calls[0], 'BEGIN');
  assert.ok(calls.some((sql) => sql.startsWith('UPDATE events')));
  assert.ok(calls.some((sql) => sql.startsWith('UPDATE users')));
  assert.ok(calls.some((sql) => sql.startsWith('ROLLBACK')));
  assert.equal(calls.some((sql) => sql.startsWith('COMMIT')), false);
});
