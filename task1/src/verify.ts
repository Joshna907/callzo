import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readConfig } from './config.js';

// Runs only when explicitly invoked, inside a disposable verification project.
const config = readConfig();
const runId = process.env.VERIFY_RUN_ID;
if (!runId || !/^[a-f\d]{12}$/.test(runId)) throw new Error('VERIFY_RUN_ID must contain 12 hexadecimal characters');
const account = `verify_${runId}`;
const capAccount = `${account}_cap`;
const baseUrl = `http://127.0.0.1:${config.port}`;
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
const headers = { Authorization: `Bearer ${config.apiKey}` };
const base = {
  event_id: `${runId}_end`, event_type: 'call.ended', account_id: account,
  call_id: `${runId}_normal`, timestamp: '2026-11-01T10:00:00.123456Z',
  duration_seconds: 120, cost_cents: 4, destination_country: 'US',
};

async function send(body: string, signature?: string) {
  return fetch(`${baseUrl}/webhooks/calls`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json',
      'X-Signature': signature ?? createHmac('sha256', config.webhookSecret).update(body).digest('hex') },
    signal: AbortSignal.timeout(10000),
  });
}
async function usage(id: string, month = '2026-11') {
  const response = await fetch(`${baseUrl}/accounts/${id}/usage?month=${month}`, {
    headers, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function drainJobs() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`SELECT status, count(*)::integer AS count FROM usage_jobs GROUP BY status`);
    assert.ok(!rows.some((row) => row.status === 'dead' && row.count > 0), 'Background jobs exhausted retries');
    if (!rows.some((row) => row.status === 'pending' && row.count > 0)) return;
    await delay(500);
  }
  throw new Error('Background queue did not drain within 60 seconds');
}
function reconcile(args: string[], expectedExit: number) {
  const result = spawnSync(process.execPath, ['dist/reconcile.js', ...args], {
    encoding: 'utf8', timeout: 60000, env: process.env,
  });
  assert.equal(result.status, expectedExit, `Reconciliation exited unexpectedly: ${result.stderr}`);
}
async function verifyPersisted() {
  const current = await usage(account);
  assert.equal(current.completed_calls, '2');
  assert.equal(current.duration_seconds, '300');
  assert.equal(current.cost_cents, '10');
  const historical = await usage(account, '2026-09');
  assert.equal(historical.completed_calls, '1');
  assert.equal(historical.cost_cents, '8');
  const capped = await usage(capAccount);
  assert.equal(capped.cost_cents, '501');
  assert.equal(capped.cap.status, 'over_limit');
  assert.equal(capped.cap.overage_cents, '1');
  assert.equal((await pool.query('SELECT count(*) FROM call_events WHERE account_id IN ($1,$2)', [account, capAccount])).rows[0].count, '8');
  await drainJobs();
}

try {
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/accounts/${account}/usage`)).status, 401);
  if (!process.argv.includes('--check-persisted')) {
    assert.equal(config.monthlyCapCents, '500', 'Run this verifier with MONTHLY_CAP_CENTS=500');
    assert.equal((await send(JSON.stringify({ ...base, event_id: `${runId}_start`, event_type: 'call.started',
      timestamp: '2026-11-01T09:58:00Z', duration_seconds: 0, cost_cents: 0 }))).status, 202);
    assert.equal((await send(JSON.stringify(base))).status, 202);
    for (let i = 0; i < 3; i++) assert.equal((await send(JSON.stringify(base, null, 2))).status, 200);
    assert.equal((await send(JSON.stringify({ ...base, cost_cents: 99 }))).status, 409);
    const outOfOrder = { ...base, event_id: `${runId}_ooo_end`, call_id: `${runId}_ooo`, duration_seconds: 180, cost_cents: 6 };
    assert.equal((await send(JSON.stringify(outOfOrder))).status, 202);
    assert.equal((await send(JSON.stringify({ ...outOfOrder, event_id: `${runId}_ooo_start`, event_type: 'call.started',
      timestamp: '2026-11-01T09:57:00Z', duration_seconds: 0, cost_cents: 0 }))).status, 202);
    assert.equal((await send(JSON.stringify({ ...base, event_id: `${runId}_old`, call_id: `${runId}_old`,
      timestamp: '2026-09-01T00:00:00Z', cost_cents: 8 }))).status, 202);
    assert.equal((await send(JSON.stringify(base), '00'.repeat(32))).status, 401);
    assert.equal((await fetch(`${baseUrl}/webhooks/calls`, { method: 'POST', body: '{' })).status, 401);
    for (const body of ['', '{', '{"event_id":']) assert.equal((await send(body)).status, 400);
    assert.equal((await send(JSON.stringify({ ...base, event_type: 'call.unknown' }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...base, cost_cents: '4' }))).status, 422);
    assert.equal((await send('x'.repeat(16385))).status, 413);

    for (const [index, cost, status] of [[0, 499, 'below_limit'], [1, 1, 'at_limit'], [2, 1, 'over_limit']] as const) {
      assert.equal((await send(JSON.stringify({ ...base, event_id: `${runId}_cap_${index}`,
        account_id: capAccount, call_id: `${runId}_cap_${index}`, cost_cents: cost }))).status, 202);
      assert.equal((await usage(capAccount)).cap.status, status);
    }
    await verifyPersisted();
    // Demonstrate a real CLI check/repair cycle against deliberately wrong audit data.
    await pool.query('UPDATE monthly_usage_snapshots SET cost_cents = 999 WHERE account_id = $1', [account]);
    assert.equal((await usage(account)).cost_cents, '10', 'Checkpoint corruption must not affect live usage');
    reconcile([account], 2);
    reconcile([account, '--repair'], 0);
    reconcile([account], 0);
  } else {
    await verifyPersisted();
  }
  if (process.env.EXPECT_SIMULATOR_EVENTS === '1') {
    const result = await pool.query("SELECT count(*)::integer AS count FROM call_events WHERE account_id ~ '^acct_[0-9]{3}$'");
    assert.ok(result.rows[0].count > 0, 'No events from the supplied simulator were stored');
    const summaries = await pool.query(`SELECT account_id, usage_month::text, completed_calls::text,
      cost_cents::text FROM monthly_usage WHERE account_id ~ '^acct_[0-9]{3}$' ORDER BY account_id, usage_month`);
    assert.ok(summaries.rows.some((row) => BigInt(row.cost_cents) > BigInt(config.monthlyCapCents)),
      'The supplied cap burst did not exceed the configured cap');
    console.log(JSON.stringify({ event: 'simulator_usage_verified', stored_events: result.rows[0].count,
      summaries: summaries.rows }));
  }
  console.log(JSON.stringify({ event: 'http_verification_passed', restart_check: process.argv.includes('--check-persisted') }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'HTTP verification failed');
  process.exitCode = 1;
} finally { await pool.end(); }
