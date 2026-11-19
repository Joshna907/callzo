import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from '../src/db/migrate.js';
import { processNextJob, retryDelaySeconds } from '../src/jobs/process.js';
import { refreshCheckpoints, type JobDatabase } from '../src/jobs/checkpoints.js';
import { reconcileAccount } from '../src/jobs/reconcile.js';

test('background checkpoints and reconciliation against embedded Postgres', async (t) => {
  const db = new PGlite();
  const database: JobDatabase = {
    query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values),
  };
  async function addEvent(id: string, cost = '4', month = '2026-11', account = 'acct_001', call = id) {
    await db.query(`INSERT INTO call_events (event_id, event_type, account_id, call_id,
      occurred_at, duration_seconds, cost_cents, destination_country, payload, raw_body)
      VALUES ($1, 'call.ended', $2, $3, $4, 120, $5, 'US', '{}'::jsonb, ''::bytea)`,
    [id, account, call, `${month}-01T00:00:00Z`, cost]);
  }
  async function enqueue(id: string, cost = '4', month = '2026-11', account = 'acct_001', call = id) {
    await addEvent(id, cost, month, account, call);
    await db.query('INSERT INTO usage_jobs (event_id) VALUES ($1)', [id]);
  }
  async function transaction<T>(work: () => Promise<T>) {
    await db.exec('BEGIN');
    try {
      const result = await work();
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }
  const run = (refresh?: typeof refreshCheckpoints) => transaction(() => processNextJob(database, refresh));
  const reconcile = (repair = false, account = 'acct_001') => transaction(() => reconcileAccount(database, account, repair));
  const checkpoint = async () => (await db.query<{ account_id: string; cost_cents: string; completed_calls: string }>(`
    SELECT account_id, cost_cents::text, completed_calls::text FROM monthly_usage_snapshots ORDER BY account_id, usage_month`)).rows;
  const reset = () => db.exec('TRUNCATE usage_jobs, call_events, monthly_usage_snapshots, reconciliation_runs');
  const makeDue = () => db.exec("UPDATE usage_jobs SET next_attempt_at = now() - interval '1 second'");
  try {
    await db.exec(migrations[0]!.sql);
    await db.exec(migrations[1]!.sql);
    await addEvent('evt_existing');
    await db.exec(migrations[2]!.sql);

    await t.test('upgrade queues events saved before the worker existed', async () => {
      assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM usage_jobs')).rows[0]!.count, 1);
      assert.equal((await run())?.status, 'completed');
      assert.deepEqual(await checkpoint(), [{ account_id: 'acct_001', cost_cents: '4', completed_calls: '1' }]);
      assert.equal(await run(), null);
    });

    await t.test('refresh is idempotent across jobs for the same call and account', async () => {
      await reset();
      await enqueue('evt_a', '4', '2026-11', 'acct_001', 'call_same');
      await enqueue('evt_b', '4', '2026-11', 'acct_001', 'call_same');
      await run();
      const before = await checkpoint();
      await run();
      assert.deepEqual(await checkpoint(), before);
      assert.equal(before[0]!.cost_cents, '4');
    });

    await t.test('failed SQL rolls back partial work, retains the job, and schedules a retry', async () => {
      await reset();
      await enqueue('evt_a');
      await run();
      await enqueue('evt_b', '6');
      const before = await checkpoint();
      const result = await run(async (database, accountId) => {
        await database.query('DELETE FROM monthly_usage_snapshots WHERE account_id = $1', [accountId]);
        await database.query('SELECT 1 / 0');
      });
      assert.equal(result?.status, 'pending');
      assert.equal(result?.attempt, 1);
      assert.deepEqual(await checkpoint(), before);
      const { rows } = await db.query<{ attempts: number; future: boolean; last_error: string }>(`
        SELECT attempts, next_attempt_at > clock_timestamp() AS future, last_error
        FROM usage_jobs WHERE event_id = 'evt_b'`);
      assert.equal(rows[0]!.attempts, 1);
      assert.equal(rows[0]!.future, true);
      assert.equal(rows[0]!.last_error, 'checkpoint_refresh_failed');
      assert.equal(await run(), null);
      await makeDue();
      assert.equal((await run())?.attempt, 2);
      assert.equal((await checkpoint())[0]!.cost_cents, '10');
    });

    await t.test('repeated failures stop after five attempts and preserve inspectable dead work', async () => {
      await reset();
      await enqueue('evt_dead');
      for (let attempt = 1; attempt <= 5; attempt++) {
        await makeDue();
        const result = await run(async () => { throw new Error('sensitive upstream detail'); });
        assert.equal(result?.attempt, attempt);
        assert.equal(result?.status, attempt === 5 ? 'dead' : 'pending');
      }
      assert.equal(await run(), null);
      const job = (await db.query<{ status: string; attempts: number; finished: boolean; last_error: string }>(`
        SELECT status, attempts, finished_at IS NOT NULL AS finished, last_error FROM usage_jobs`)).rows[0]!;
      assert.equal(job.status, 'dead');
      assert.equal(job.attempts, 5);
      assert.equal(job.finished, true);
      assert.ok(!job.last_error.includes('sensitive'));
      assert.deepEqual(await checkpoint(), []);
    });

    await t.test('a rolled-back worker transaction can safely run again', async () => {
      await reset();
      await enqueue('evt_crash');
      await db.exec('BEGIN');
      assert.equal((await processNextJob(database))?.status, 'completed');
      await db.exec('ROLLBACK');
      assert.deepEqual(await checkpoint(), []);
      assert.equal((await run())?.attempt, 1);
      assert.equal((await checkpoint())[0]!.cost_cents, '4');
    });

    await t.test('reconciliation detects wrong, missing, and extra months without changing them', async () => {
      await reset();
      await enqueue('evt_nov');
      await enqueue('evt_oct', '6', '2026-10');
      await run();
      await db.exec(`UPDATE monthly_usage_snapshots SET cost_cents = 999 WHERE usage_month = '2026-11-01';
        DELETE FROM monthly_usage_snapshots WHERE usage_month = '2026-10-01';
        INSERT INTO monthly_usage_snapshots (account_id, usage_month, completed_calls, duration_seconds, cost_cents)
          VALUES ('acct_001', '2026-09-01', 1, 1, 1)`);
      const before = await checkpoint();
      const result = await reconcile();
      assert.equal(result.differing_months, 3);
      assert.equal(result.mode, 'check');
      assert.deepEqual(await checkpoint(), before);
      assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM reconciliation_runs')).rows[0]!.count, 1);
    });

    await t.test('repair rebuilds all affected months and a second check is clean', async () => {
      const result = await reconcile(true);
      assert.equal(result.differing_months, 3);
      assert.deepEqual((await checkpoint()).map((row) => row.cost_cents), ['6', '4']);
      assert.equal((await reconcile()).differing_months, 0);
      assert.equal((await reconcile(true)).differing_months, 0);
    });

    await t.test('reconciliation handles stale-only accounts and leaves other accounts untouched', async () => {
      await enqueue('evt_other', '9', '2026-11', 'acct_002');
      while (await run()) { /* drain durable jobs */ }
      const before = (await checkpoint()).filter((row) => row.account_id === 'acct_002');
      await db.exec(`INSERT INTO monthly_usage_snapshots
        (account_id, usage_month, completed_calls, duration_seconds, cost_cents)
        VALUES ('acct_stale', '2026-11-01', 1, 1, 1)`);
      assert.equal((await reconcile(true, 'acct_stale')).differing_months, 1);
      assert.deepEqual((await checkpoint()).filter((row) => row.account_id === 'acct_stale'), []);
      assert.deepEqual((await checkpoint()).filter((row) => row.account_id === 'acct_002'), before);
    });

    await t.test('late events and large exact totals flow into refreshed checkpoints', async () => {
      await reset();
      await enqueue('evt_large_a', '9007199254740991', '2026-01');
      await enqueue('evt_large_b', '9007199254740991', '2026-01');
      await run();
      assert.equal((await checkpoint())[0]!.cost_cents, '18014398509481982');
      assert.equal((await reconcile()).differing_months, 0);
    });
  } finally { await db.close(); }
});

test('retry backoff grows and has a fixed upper bound', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelaySeconds), [1, 2, 4, 8, 16]);
  assert.equal(retryDelaySeconds(20), 60);
});
