import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { describeUsage, type UsageTotals } from '../src/usage/service.js';

const apiKey = 'test-only-administrator-key-at-least-32-characters';
const zero: UsageTotals = { completed_calls: '0', duration_seconds: '0', cost_cents: '0' };
function setup(readUsage: (account: string, month: string) => Promise<UsageTotals> = async () => zero) {
  return createApp(async () => {}, {
    secret: 'webhook-test-secret', receiveEvent: async () => 'accepted',
  }, {
    apiKey, monthlyCapCents: '1000', readUsage,
    now: () => new Date('2026-11-01T00:15:00Z'),
  });
}
const auth = { Authorization: `Bearer ${apiKey}` };

test('usage authentication rejects missing, malformed, and wrong keys before any query', async () => {
  let reads = 0;
  const app = setup(async () => { reads++; return zero; });
  for (const authorization of ['', 'Basic abc', 'Bearer wrong', `Bearer ${apiKey} extra`, 'Bearer']) {
    const response = await app.request('/accounts/acct_001/usage?month=invalid', {
      headers: { Authorization: authorization },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer realm="usage"');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(reads, 0);
});

test('usage request defaults to current UTC month and keeps the account boundary', async () => {
  const requests: string[][] = [];
  const app = setup(async (account, month) => {
    requests.push([account, month]);
    return { completed_calls: '2', duration_seconds: '300', cost_cents: '10' };
  });
  const response = await app.request('/accounts/acct_002/usage', { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(requests, [['acct_002', '2026-11']]);
  assert.equal(body.account_id, 'acct_002');
  assert.equal(body.month, '2026-11');
  assert.equal(body.timezone, 'UTC');
  assert.equal(body.duration_seconds, '300');
  assert.equal(body.cap.remaining_cents, '990');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('historical month is passed through and empty usage has zero totals', async () => {
  const app = setup(async (account, month) => {
    assert.equal(account, 'acct_no_events');
    assert.equal(month, '2026-09');
    return zero;
  });
  const response = await app.request('/accounts/acct_no_events/usage?month=2026-09', { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cost_cents, '0');
  assert.equal(body.completed_calls, '0');
  assert.equal(body.cap.status, 'below_limit');
});

test('invalid months, repeated parameters, unknown filters, and blank accounts are rejected', async () => {
  let reads = 0;
  const app = setup(async () => { reads++; return zero; });
  for (const query of ['month=', 'month=2026-00', 'month=2026-13', 'month=26-11',
    'month=0000-01', 'month=2026-1', 'month=2026-11-01', 'month=2026-11&month=2026-10', 'other=x']) {
    assert.equal((await app.request(`/accounts/acct_001/usage?${query}`, { headers: auth })).status, 400, query);
  }
  assert.equal((await app.request('/accounts/%20/usage', { headers: auth })).status, 400);
  assert.equal((await app.request(`/accounts/${'a'.repeat(256)}/usage`, { headers: auth })).status, 400);
  assert.equal(reads, 0);
});

test('usage read failure returns a retryable response without leaking database details', async () => {
  const app = setup(async () => { throw new Error('postgres://private:password@database'); });
  const response = await app.request('/accounts/acct_001/usage', { headers: auth });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('password'));
});

test('soft cap distinguishes below, exactly at, and above the limit', () => {
  for (const [cost, status, remaining, overage, reached, exceeded] of [
    ['999', 'below_limit', '1', '0', false, false],
    ['1000', 'at_limit', '0', '0', true, false],
    ['1001', 'over_limit', '0', '1', true, true],
  ] as const) {
    const result = describeUsage('acct_001', '2026-11', { ...zero, cost_cents: cost }, '1000');
    assert.equal(result.cost_cents, cost);
    assert.deepEqual(result.cap, {
      type: 'soft', limit_cents: '1000', remaining_cents: remaining, overage_cents: overage,
      reached, exceeded, status,
    });
  }
});

test('zero caps and totals exceeding JS safe integer range remain exact', () => {
  assert.equal(describeUsage('a', '2026-11', zero, '0').cap.status, 'at_limit');
  const result = describeUsage('a', '2026-11', { ...zero, cost_cents: '18014398509481982' }, '1000');
  assert.equal(result.cap.overage_cents, '18014398509480982');
  assert.equal(JSON.parse(JSON.stringify(result)).cost_cents, '18014398509481982');
});

test('startup validates independent API keys and exact integer cap settings', () => {
  const env = { DATABASE_URL: 'postgres://localhost/callzo', WEBHOOK_SECRET: 'webhook-only-secret', API_KEY: apiKey };
  assert.throws(() => readConfig({ ...env, API_KEY: undefined }), /API_KEY/);
  assert.throws(() => readConfig({ ...env, API_KEY: 'short' }), /API_KEY/);
  assert.throws(() => readConfig({ ...env, API_KEY: `${apiKey} space` }), /API_KEY/);
  assert.throws(() => readConfig({ ...env, WEBHOOK_SECRET: apiKey }), /differ/);
  for (const value of ['', '-1', '1.5', '1e3', ' 10', '01', '9223372036854775808']) {
    assert.throws(() => readConfig({ ...env, MONTHLY_CAP_CENTS: value }), /MONTHLY_CAP_CENTS/);
  }
  assert.equal(readConfig(env).monthlyCapCents, '500');
  assert.equal(readConfig({ ...env, MONTHLY_CAP_CENTS: '0' }).monthlyCapCents, '0');
  assert.equal(readConfig({ ...env, MONTHLY_CAP_CENTS: '9223372036854775807' }).monthlyCapCents, '9223372036854775807');
});
