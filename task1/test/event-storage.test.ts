import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { migrations } from '../src/db/migrate.js';
import { createEventReceiver } from '../src/db/events.js';

test('webhook event and job commit atomically against embedded Postgres', async (t) => {
  const db = new PGlite();
  const receiver = createEventReceiver({ connect: async () => ({
    query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values), release() {},
  }) });
  const secret = 'embedded-webhook-secret';
  const app = createApp(async () => {}, { secret, receiveEvent: receiver });
  const event = {
    event_id: 'evt_atomic', event_type: 'call.ended', account_id: 'acct_001', call_id: 'call_001',
    timestamp: '2026-11-01T00:00:00Z', duration_seconds: 120, cost_cents: 4, destination_country: 'US',
  };
  const send = (body: string) => app.request('/webhooks/calls', {
    method: 'POST', body, headers: {
      'X-Signature': createHmac('sha256', secret).update(body).digest('hex'),
      'Content-Type': 'application/json',
    },
  });
  const count = async (table: 'call_events' | 'usage_jobs') =>
    (await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count;
  try {
    for (const migration of migrations) await db.exec(migration.sql);

    await t.test('queue insertion failure rolls back the raw event and reports 503', async () => {
      await db.exec(`CREATE FUNCTION reject_job() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test-only failure'; END $$;
        CREATE TRIGGER reject_job BEFORE INSERT ON usage_jobs FOR EACH ROW EXECUTE FUNCTION reject_job()`);
      assert.equal((await send(JSON.stringify(event))).status, 503);
      assert.equal(await count('call_events'), 0);
      assert.equal(await count('usage_jobs'), 0);
      await db.exec('DROP TRIGGER reject_job ON usage_jobs; DROP FUNCTION reject_job()');
    });

    await t.test('retry stores exactly one raw event and pending job', async () => {
      assert.equal((await send(JSON.stringify(event))).status, 202);
      assert.equal(await count('call_events'), 1);
      assert.equal(await count('usage_jobs'), 1);
      const { rows } = await db.query<{ status: string; attempts: number }>('SELECT status, attempts FROM usage_jobs');
      assert.deepEqual(rows, [{ status: 'pending', attempts: 0 }]);
    });

    await t.test('duplicate deliveries do not create or reset jobs; conflicts do not overwrite', async () => {
      await db.exec("UPDATE usage_jobs SET status = 'dead', attempts = 5");
      assert.equal((await send(JSON.stringify(event, null, 2))).status, 200);
      assert.equal((await send(JSON.stringify({ ...event, cost_cents: 99 }))).status, 409);
      assert.equal(await count('call_events'), 1);
      assert.equal(await count('usage_jobs'), 1);
      assert.equal((await db.query<{ attempts: number }>('SELECT attempts FROM usage_jobs')).rows[0]!.attempts, 5);
      assert.equal((await db.query<{ cost: string }>('SELECT cost_cents::text AS cost FROM call_events')).rows[0]!.cost, '4');
    });
  } finally { await db.close(); }
});
