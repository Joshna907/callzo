import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readQuery, summaryParams, tableParams, togglePageSelection, validDate } from '../src/query.ts';
import { decodeAccounts, decodeSummary, stabilizeAccounts, type Account } from '../src/api.ts';

const account = (id: number, minutes = 100): Account => ({
  id, name: `Account ${id}`, email: `${id}@example.com`, company: 'Example', country: 'US',
  plan: 'pro', status: 'active', signup_date: '2026-01-01', last_active: '2026-11-01',
  current_month_minutes: minutes, current_month_sms: 10, cost_cents: 100,
});
test('URL defaults and invalid filters normalize to valid requests', () => {
  const result = readQuery('?page=-5&page_size=999&sort_by=bad&status=unknown&country=abc&plan=gold');
  assert.equal(result.page, 1);
  assert.equal(result.page_size, 25);
  assert.equal(result.sort_by, 'current_month_minutes');
  assert.equal(result.status, '');
  assert.equal(result.country, '');
  assert.equal(result.plan, '');
});
test('date ranges reject impossible dates and inverted boundaries', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('0000-01-01'), false);
  assert.equal(validDate('2024-02-29'), true);
  const result = readQuery('?date_from=2026-11-01&date_to=2026-01-01');
  assert.equal(result.date_from, '');
  assert.equal(result.date_to, '');
});
test('table query round-trips while summary receives only supported date filters', () => {
  const query = readQuery('?search=Orbit%20%26%20Co&status=active&country=IN&page=2&date_from=2026-01-01');
  assert.deepEqual(readQuery(`?${tableParams(query)}`), query);
  assert.equal(summaryParams(query), 'date_from=2026-01-01');
});
test('selecting and deselecting a page preserves selections on other pages', () => {
  const original = new Set([90, 1]);
  const next = togglePageSelection(original, [1, 2, 3]);
  assert.deepEqual([...next], [90, 1, 2, 3]);
  assert.deepEqual([...togglePageSelection(next, [1, 2, 3])], [90]);
  assert.deepEqual([...original], [90, 1]);
});
test('refresh applies new values without moving retained rows', () => {
  const previous = { data: [account(1), account(2), account(3)], page: 1, page_size: 3, total: 4 };
  const fresh = { ...previous, data: [account(2, 110), account(1, 90), account(4, 70)] };
  const result = stabilizeAccounts(previous, fresh);
  assert.deepEqual(result.data.map((row) => row.id), [1, 2, 4]);
  assert.deepEqual(result.data.map((row) => row.current_month_minutes), [90, 110, 70]);
  assert.equal(previous.data[0]!.current_month_minutes, 100);
});
test('invalid account responses and numeric types fail clearly instead of crashing rendering', () => {
  assert.throws(() => decodeAccounts({ data: [{ ...account(1), cost_cents: '100' }], page: 1, page_size: 1, total: 1 }));
  assert.throws(() => decodeAccounts({ error: 'offline' }));
  assert.equal(decodeAccounts({ data: [], page: 1, page_size: 25, total: 0 }).total, 0);
});
test('empty chart data is valid; incomplete or malformed chart points are rejected', () => {
  assert.deepEqual(decodeSummary({ series: [], total_accounts: 0 }), { series: [], total_accounts: 0 });
  assert.throws(() => decodeSummary({ series: [{ date: '2026-01-01', minutes: 10 }], total_accounts: 1 }));
  assert.throws(() => decodeSummary(null));
});
