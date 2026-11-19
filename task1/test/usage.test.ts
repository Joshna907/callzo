import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from '../src/db/migrate.js';
import type { CallEvent } from '../src/webhooks/event.js';
import { createUsageReader, type UsageTotals } from '../src/usage/service.js';
import { createApp } from '../src/app.js';

const base: CallEvent = {
  event_id: 'evt_end', event_type: 'call.ended', account_id: 'acct_001', call_id: 'call_001',
  timestamp: '2026-11-01T10:00:00.123456Z', duration_seconds: 120,
  cost_cents: 4, destination_country: 'US',
};

interface UsageRow {
  account_id: string;
  usage_month: string;
  completed_calls: string;
  duration_seconds: string;
  cost_cents: string;
}
interface CallRow {
  state: 'started' | 'ended' | 'failed';
  source_event_id: string;
  cost_cents: string;
  started_at: string | null;
}

test('usage projections against embedded Postgres', async (t) => {
  const db = new PGlite();
  async function insert(event: CallEvent) {
    await db.query(`INSERT INTO call_events (
      event_id, event_type, account_id, call_id, occurred_at,
      duration_seconds, cost_cents, destination_country, payload, raw_body
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT DO NOTHING`,
    [event.event_id, event.event_type, event.account_id, event.call_id, event.timestamp,
      event.duration_seconds, event.cost_cents, event.destination_country,
      JSON.stringify(event), Buffer.from(JSON.stringify(event))]);
  }
  const usage = async () => (await db.query<UsageRow>(`SELECT account_id, usage_month::text,
    completed_calls::text, duration_seconds::text, cost_cents::text
    FROM monthly_usage ORDER BY account_id, usage_month`)).rows;
  const call = async () => (await db.query<CallRow>(`SELECT state, source_event_id, cost_cents::text,
    to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS started_at
    FROM calls ORDER BY call_id`)).rows;
  async function reset() { await db.exec('TRUNCATE call_events'); }

  try {
    // Apply actual production schema SQL, including a historical event before v2.
    await db.exec(migrations[0]!.sql);
    await insert(base);
    await db.exec(migrations[1]!.sql);

    await t.test('views include events stored before the new migration', async () => {
      assert.deepEqual(await usage(), [{ account_id: 'acct_001', usage_month: '2026-11-01',
        completed_calls: '1', duration_seconds: '120', cost_cents: '4' }]);
    });

    await t.test('a start alone has no usage; an end adds the supplied totals', async () => {
      await reset();
      const start: CallEvent = { ...base, event_id: 'evt_start', event_type: 'call.started',
        timestamp: '2026-11-01T09:58:00.123456Z', duration_seconds: 0, cost_cents: 0 };
      await insert(start);
      assert.deepEqual(await usage(), []);
      assert.equal((await call())[0]!.state, 'started');
      await insert(base);
      assert.equal((await call())[0]!.state, 'ended');
      assert.equal((await usage())[0]!.duration_seconds, '120');
    });

    await t.test('end before start remains ended and usage does not increase again', async () => {
      await reset();
      await insert(base);
      const before = await usage();
      await insert({ ...base, event_id: 'evt_start', event_type: 'call.started',
        timestamp: '2026-11-01T09:58:00.123456Z', duration_seconds: 0, cost_cents: 0 });
      assert.deepEqual(await usage(), before);
      assert.deepEqual(await call(), [{ state: 'ended', source_event_id: 'evt_end',
        cost_cents: '4', started_at: '2026-11-01 09:58:00.123456' }]);
    });

    await t.test('same event and different event IDs for one ended call count once', async () => {
      await reset();
      await insert(base);
      await insert(base);
      await insert({ ...base, event_id: 'evt_repeat' });
      assert.equal((await usage())[0]!.completed_calls, '1');
      assert.equal((await usage())[0]!.cost_cents, '4');
    });

    await t.test('failed calls have no usage; an ended event takes precedence', async () => {
      await reset();
      const failed: CallEvent = { ...base, event_id: 'evt_failed', event_type: 'call.failed', duration_seconds: 0, cost_cents: 0 };
      await insert(failed);
      assert.equal((await call())[0]!.state, 'failed');
      assert.deepEqual(await usage(), []);
      await insert(base);
      assert.equal((await call())[0]!.state, 'ended');
      await insert({ ...failed, event_id: 'evt_failed_again', timestamp: '2026-11-02T10:00:00Z' });
      assert.equal((await call())[0]!.state, 'ended');
      assert.equal((await usage())[0]!.cost_cents, '4');
    });

    await t.test('late events and cross-month calls use the UTC end month', async () => {
      await reset();
      await insert({ ...base, event_id: 'evt_oct_start', event_type: 'call.started',
        timestamp: '2026-10-31T23:59:00Z', duration_seconds: 0, cost_cents: 0 });
      await insert({ ...base, timestamp: '2026-11-01T00:01:00Z' });
      await insert({ ...base, event_id: 'evt_late', call_id: 'call_old', timestamp: '2026-09-10T00:00:00Z' });
      await insert({ ...base, event_id: 'evt_offset', call_id: 'call_offset', timestamp: '2026-11-01T00:15:00+05:30' });
      assert.deepEqual((await usage()).map((r) => r.usage_month), ['2026-09-01', '2026-10-01', '2026-11-01']);
      await db.exec("SET TIME ZONE 'Pacific/Honolulu'");
      assert.deepEqual((await usage()).map((r) => r.usage_month), ['2026-09-01', '2026-10-01', '2026-11-01']);
    });

    await t.test('account boundaries and call IDs do not mix; large sums stay exact', async () => {
      await reset();
      const large = { ...base, cost_cents: Number.MAX_SAFE_INTEGER };
      await insert(large);
      await insert({ ...large, event_id: 'evt_other_call', call_id: 'call_002' });
      await insert({ ...base, event_id: 'evt_other_account', account_id: 'acct_002' });
      const rows = await usage();
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.completed_calls, '2');
      assert.equal(rows[0]!.cost_cents, '18014398509481982');
      assert.equal(rows[1]!.cost_cents, '4');
    });

    await t.test('conflicting terminal events resolve by timestamp, then ID, independent of arrival', async () => {
      await reset();
      const early = { ...base, event_id: 'evt_a', cost_cents: 3 };
      const sameTime = { ...early, event_id: 'evt_b', cost_cents: 7 };
      const later = { ...base, event_id: 'evt_later', timestamp: '2026-11-02T00:00:00Z', cost_cents: 9 };
      for (const event of [later, sameTime, early]) await insert(event);
      const first = await usage();
      assert.equal(first[0]!.cost_cents, '3');
      assert.equal((await call())[0]!.source_event_id, 'evt_a');
      await reset();
      for (const event of [early, sameTime, later]) await insert(event);
      assert.deepEqual(await usage(), first);
    });

    await t.test('event timestamp precision decides ties within the same millisecond', async () => {
      await reset();
      await insert({ ...base, event_id: 'evt_a_later', timestamp: '2026-11-01T10:00:00.123457Z', cost_cents: 9 });
      await insert({ ...base, event_id: 'evt_z_earlier', timestamp: '2026-11-01T10:00:00.123456Z', cost_cents: 2 });
      assert.equal((await usage())[0]!.cost_cents, '2');
    });

    await t.test('rolled-back events never affect visible usage', async () => {
      await reset();
      await db.exec('BEGIN');
      await insert(base);
      assert.equal((await usage()).length, 1);
      await db.exec('ROLLBACK');
      assert.deepEqual(await usage(), []);
      assert.deepEqual(await call(), []);
    });

    await t.test('authenticated API reads actual usage and crosses a soft cap during a burst', async () => {
      await reset();
      const key = 'embedded-api-test-key-at-least-32-characters';
      const app = createApp(async () => {}, {
        secret: 'separate-webhook-secret', receiveEvent: async () => 'accepted',
      }, {
        apiKey: key, monthlyCapCents: '1000',
        readUsage: createUsageReader({ query: (sql, values) => db.query<UsageTotals>(sql, values) }),
      });
      const getUsage = async (account = 'acct_001', month = '2026-11') => {
        const response = await app.request(`/accounts/${account}/usage?month=${month}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.equal((await getUsage()).cost_cents, '0');
      for (let i = 1; i <= 40; i++) {
        await insert({ ...base, event_id: `evt_burst_${i}`, call_id: `call_burst_${i}`, cost_cents: 100 });
        if ([9, 10, 11, 40].includes(i)) {
          const body = await getUsage();
          assert.equal(body.cost_cents, String(i * 100));
          assert.equal(body.completed_calls, String(i));
          assert.equal(body.cap.status, i < 10 ? 'below_limit' : i === 10 ? 'at_limit' : 'over_limit');
        }
      }
      const afterBurst = await getUsage();
      assert.equal(afterBurst.cap.overage_cents, '3000');
      assert.equal(afterBurst.cap.remaining_cents, '0');
      assert.equal((await getUsage('acct_002')).cost_cents, '0');
      assert.equal((await getUsage('acct_001', '2026-12')).cost_cents, '0');

      await insert({ ...base, event_id: 'evt_historical', call_id: 'call_historical', timestamp: '2026-09-01T00:00:00Z' });
      assert.equal((await getUsage('acct_001', '2026-09')).cost_cents, '4');
      assert.deepEqual(await getUsage(), afterBurst);
    });
  } finally {
    await db.close();
  }
});
