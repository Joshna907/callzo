import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { createEventReceiver } from '../../src/db/events.js';
import type { CallEvent } from '../../src/webhooks/event.js';
import { createUsageReader } from '../../src/usage/service.js';
import { runWorkerOnce } from '../../src/jobs/worker.js';
import { reconcileAccount } from '../../src/jobs/reconcile.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is required. Use the isolated compose.test.yaml setup described in README.md.');
}

test('Postgres event storage', async (t) => {
  // Each run owns a unique schema. Never truncate or drop existing app tables.
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const pool = new pg.Pool({
    connectionString, max: 10, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`,
  });
  const secret = 'integration-test-only';
  const apiKey = 'integration-administrator-key-at-least-32-characters';
  const event: CallEvent = {
    event_id: 'evt_integration', event_type: 'call.ended', account_id: 'acct_001',
    call_id: 'call_001', timestamp: '2026-11-01T10:15:30.123456+00:00',
    duration_seconds: 120, cost_cents: 4, destination_country: 'US',
  };
  const app = createApp(async () => { await pool.query('SELECT 1 FROM call_events LIMIT 0'); }, {
    secret, receiveEvent: createEventReceiver(pool),
  }, {
    apiKey, monthlyCapCents: '1000', readUsage: createUsageReader(pool),
  });
  const send = (body: string, signature?: string) => app.request('/webhooks/calls', {
    method: 'POST', body, headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature ?? createHmac('sha256', secret).update(body).digest('hex'),
    },
  });

  try {
    await admin.query(`CREATE SCHEMA ${schema}`);

    await t.test('concurrent migration runs apply schema exactly once', async () => {
      await Promise.all([migrate(pool), migrate(pool)]);
      await migrate(pool);
      const result = await pool.query('SELECT version FROM schema_migrations');
      assert.deepEqual(result.rows.map((r) => r.version).sort(), [1, 2, 3]);
      assert.equal((await app.request('/ready')).status, 200);
    });

    await t.test('saves the event, original bytes, and microsecond event timestamp', async () => {
      const body = JSON.stringify(event, null, 2);
      const response = await send(body);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { status: 'accepted', event_id: event.event_id });
      const { rows } = await pool.query(`SELECT *,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS event_time
        FROM call_events WHERE event_id = $1`, [event.event_id]);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].payload, event);
      assert.equal(rows[0].raw_body.toString('utf8'), body);
      assert.equal((await pool.query('SELECT status FROM usage_jobs WHERE event_id = $1', [event.event_id])).rows[0].status, 'pending');
      assert.equal(rows[0].cost_cents, '4'); // pg returns bigint as strings to avoid precision loss.
      assert.equal(rows[0].duration_seconds, '120');
      assert.equal(rows[0].event_time, '2026-11-01 10:15:30.123456');
      assert.ok(rows[0].received_at instanceof Date);
    });

    await t.test('reordered or reformatted JSON is a duplicate; original bytes stay intact', async () => {
      const reordered = Object.fromEntries(Object.entries(event).reverse());
      const response = await send(JSON.stringify(reordered));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'duplicate');
      const { rows } = await pool.query('SELECT raw_body FROM call_events WHERE event_id = $1', [event.event_id]);
      assert.equal(rows[0].raw_body.toString(), JSON.stringify(event, null, 2));
    });

    await t.test('authenticated usage reads the committed webhook without double counting', async () => {
      const response = await app.request('/accounts/acct_001/usage?month=2026-11', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.completed_calls, '1');
      assert.equal(body.duration_seconds, '120');
      assert.equal(body.cost_cents, '4');
      assert.equal(body.cap.remaining_cents, '996');
      assert.equal((await app.request('/accounts/acct_001/usage')).status, 401);
    });

    await t.test('twenty simultaneous copies create exactly one row', async () => {
      const concurrentEvent = { ...event, event_id: 'evt_concurrent' };
      const body = JSON.stringify(concurrentEvent);
      const responses = await Promise.all(Array.from({ length: 20 }, () => send(body)));
      assert.equal(responses.filter((r) => r.status === 202).length, 1);
      assert.equal(responses.filter((r) => r.status === 200).length, 19);
      const { rows } = await pool.query('SELECT count(*) AS count FROM call_events WHERE event_id = $1', [concurrentEvent.event_id]);
      assert.equal(rows[0].count, '1');
      assert.equal((await pool.query('SELECT count(*) FROM usage_jobs WHERE event_id = $1', [concurrentEvent.event_id])).rows[0].count, '1');
    });

    await t.test('concurrent changed payloads produce one winner and one conflict', async () => {
      const a = { ...event, event_id: 'evt_conflict', cost_cents: 5 };
      const b = { ...a, cost_cents: 6 };
      const responses = await Promise.all([send(JSON.stringify(a)), send(JSON.stringify(b))]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
      const { rows } = await pool.query('SELECT cost_cents FROM call_events WHERE event_id = $1', [a.event_id]);
      assert.equal(rows.length, 1);
      assert.ok(['5', '6'].includes(rows[0].cost_cents));
      const changed = { ...a, cost_cents: 99 };
      assert.equal((await send(JSON.stringify(changed))).status, 409);
      assert.deepEqual((await pool.query('SELECT cost_cents FROM call_events WHERE event_id = $1', [a.event_id])).rows, rows);
    });

    await t.test('bad signatures and invalid events never insert a row', async () => {
      const count = async () => (await pool.query('SELECT count(*) FROM call_events')).rows[0].count;
      const before = await count();
      assert.equal((await send(JSON.stringify({ ...event, event_id: 'evt_invalid' }), '00'.repeat(32))).status, 401);
      assert.equal((await send(JSON.stringify({ ...event, event_id: 'evt_invalid', cost_cents: -1 }))).status, 422);
      assert.equal(await count(), before);
    });

    await t.test('late and out-of-order events are retained without requiring a start first', async () => {
      const ended = { ...event, event_id: 'evt_old_end', call_id: 'call_old', timestamp: '2026-01-01T00:00:00Z' };
      const started = { ...ended, event_id: 'evt_old_start', event_type: 'call.started', duration_seconds: 0, cost_cents: 0 };
      assert.equal((await send(JSON.stringify(ended))).status, 202);
      assert.equal((await send(JSON.stringify(started))).status, 202);
      assert.equal((await pool.query('SELECT count(*) FROM call_events WHERE call_id = $1', ['call_old'])).rows[0].count, '2');
      const call = (await pool.query('SELECT state, cost_cents FROM calls WHERE call_id = $1', ['call_old'])).rows[0];
      assert.deepEqual(call, { state: 'ended', cost_cents: '4' });
      const usage = (await pool.query(`SELECT cost_cents::text, completed_calls::text FROM monthly_usage
        WHERE account_id = $1 AND usage_month = $2::date`, ['acct_001', '2026-01-01'])).rows[0];
      assert.deepEqual(usage, { cost_cents: '4', completed_calls: '1' });
    });

    await t.test('SQL-looking identifiers are stored as data', async () => {
      const unusual = { ...event, event_id: "evt_'); DROP TABLE call_events; --" };
      assert.equal((await send(JSON.stringify(unusual))).status, 202);
      assert.equal((await pool.query('SELECT event_id FROM call_events WHERE event_id = $1', [unusual.event_id])).rows[0].event_id, unusual.event_id);
    });

    await t.test('worker skips a locked job and concurrent workers safely maintain checkpoints', async () => {
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        const locked = await blocker.query(`SELECT event_id FROM usage_jobs WHERE status = 'pending'
          ORDER BY next_attempt_at, event_id COLLATE "C" LIMIT 1 FOR UPDATE`);
        const result = await runWorkerOnce(pool);
        assert.ok(result);
        assert.notEqual(result.event_id, locked.rows[0].event_id);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await Promise.all(Array.from({ length: 4 }, () => runWorkerOnce(pool)));
      while (await runWorkerOnce(pool)) { /* drain remaining jobs */ }
      assert.equal((await pool.query("SELECT count(*) FROM usage_jobs WHERE status <> 'completed'")).rows[0].count, '0');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        assert.equal((await reconcileAccount(client, 'acct_001', false)).differing_months, 0);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    });

    await t.test('reconnecting preserves events, and unavailable storage returns 503', async () => {
      await pool.end();
      const reconnect = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        assert.equal((await reconnect.query('SELECT count(*) FROM call_events WHERE event_id = $1', [event.event_id])).rows[0].count, '1');
      } finally { await reconnect.end(); }
      assert.equal((await send(JSON.stringify({ ...event, event_id: 'evt_unavailable' }))).status, 503);
      assert.equal((await app.request('/ready')).status, 503);
    });
  } finally {
    if (!pool.ended) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
