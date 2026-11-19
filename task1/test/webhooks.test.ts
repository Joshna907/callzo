import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { CallEvent } from '../src/webhooks/event.js';
import { EventConflictError } from '../src/db/events.js';

const secret = 'unit-test-only-secret';
const event = {
  event_id: 'evt_001', event_type: 'call.ended', account_id: 'acct_001',
  call_id: 'call_001', timestamp: '2026-11-01T10:15:30.123456+00:00',
  duration_seconds: 120, cost_cents: 4, destination_country: 'US',
};
function signed(body: string | Uint8Array) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
function setup() {
  const received: { event: CallEvent; raw: Uint8Array }[] = [];
  const app = createApp(async () => {}, {
    secret,
    receiveEvent: async (event, raw) => { received.push({ event, raw }); return 'accepted'; },
  });
  const send = (body: string, signature: string | undefined = signed(body)) => app.request('/webhooks/calls', {
    method: 'POST', body,
    headers: signature === undefined ? {} : { 'X-Signature': signature, 'Content-Type': 'application/json' },
  });
  return { app, received, send };
}

test('all event types and microsecond timestamps reach storage with original bytes', async () => {
  const { received, send } = setup();
  for (const event_type of ['call.started', 'call.ended', 'call.failed']) {
    const body = JSON.stringify({ ...event, event_type, duration_seconds: 0, cost_cents: 0 }, null, 2);
    const response = await send(body);
    assert.equal(response.status, 202);
    assert.equal(Buffer.from(received.at(-1)!.raw).toString(), body);
  }
  assert.equal(received.length, 3);
});

test('missing, malformed, wrong, and incorrect-length signatures never reach storage', async () => {
  const { app, received, send } = setup();
  assert.equal((await app.request('/webhooks/calls', { method: 'POST', body: '{' })).status, 401);
  for (const signature of ['', 'xyz', 'aa', 'g'.repeat(64), '00'.repeat(32), 'aa'.repeat(33)]) {
    assert.equal((await send('{', signature)).status, 401);
  }
  assert.equal(received.length, 0);
});

test('changing whitespace invalidates a signature calculated from different bytes', async () => {
  const { received, send } = setup();
  const compact = JSON.stringify(event);
  const formatted = JSON.stringify(event, null, 2);
  assert.equal((await send(formatted, signed(compact))).status, 401);
  assert.equal((await send(formatted, signed(formatted).toUpperCase())).status, 202);
  assert.equal(received.length, 1);
});

test('signed empty or truncated JSON returns 400 and subsequent requests still work', async () => {
  const { received, send } = setup();
  for (const body of ['', '{', '{"event_id":']) assert.equal((await send(body)).status, 400);
  assert.equal(received.length, 0);
  assert.equal((await send(JSON.stringify(event))).status, 202);
});

test('schema errors return 422 without invoking storage', async () => {
  const { received, send } = setup();
  const missing = { ...event } as Record<string, unknown>;
  delete missing.call_id;
  const invalid = [null, [], {}, missing,
    { ...event, event_type: 'call.unknown' },
    { ...event, event_id: '   ' },
    { ...event, duration_seconds: '120' },
    { ...event, duration_seconds: -1 },
    { ...event, cost_cents: 1.5 },
    { ...event, cost_cents: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, timestamp: '2026-02-30T00:00:00Z' },
    { ...event, timestamp: '2026-11-01T00:00:00' },
    { ...event, event_type: 'call.started' },
  ];
  for (const payload of invalid) {
    const response = await send(JSON.stringify(payload));
    assert.equal(response.status, 422, JSON.stringify(payload));
    assert.equal((await response.json()).error, 'Invalid call event');
  }
  assert.equal(received.length, 0);
});

test('body size is limited even without Content-Length', async () => {
  const { received, send } = setup();
  assert.equal((await send('x'.repeat(16 * 1024 + 1))).status, 413);
  assert.equal(received.length, 0);
});

test('invalid UTF-8 is rejected after signature verification', async () => {
  const { app, received } = setup();
  const bytes = new Uint8Array([0xff]);
  const response = await app.request('/webhooks/calls', {
    method: 'POST', body: bytes, headers: { 'X-Signature': signed(bytes) },
  });
  assert.equal(response.status, 400);
  assert.equal(received.length, 0);
});

test('failing storage never returns a success acknowledgement', async () => {
  for (const receiveEvent of [async (): Promise<never> => { throw new Error('private database details'); }]) {
    const app = createApp(async () => {}, { secret, receiveEvent });
    const body = JSON.stringify(event);
    const response = await app.request('/webhooks/calls', {
      method: 'POST', body, headers: { 'X-Signature': signed(body) },
    });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private database details'));
  }
});

test('duplicates are acknowledged and conflicting event IDs return 409', async () => {
  for (const conflict of [false, true]) {
    const app = createApp(async () => {}, {
      secret,
      receiveEvent: async () => {
        if (conflict) throw new EventConflictError();
        return 'duplicate';
      },
    });
    const body = JSON.stringify(event);
    const response = await app.request('/webhooks/calls', {
      method: 'POST', body, headers: { 'X-Signature': signed(body) },
    });
    assert.equal(response.status, conflict ? 409 : 200);
    const result = await response.json();
    assert.equal(result.event_id, event.event_id);
    if (!conflict) assert.equal(result.status, 'duplicate');
  }
});

test('health and database readiness remain independent', async () => {
  const app = createApp(async () => { throw new Error('offline'); }, { secret, receiveEvent: async () => 'accepted' });
  assert.equal((await app.request('/health')).status, 200);
  assert.equal((await app.request('/ready')).status, 503);
  assert.equal((await app.request('/unknown')).status, 404);
});

test('startup rejects missing webhook secrets', () => {
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://localhost/callzo' }), /WEBHOOK_SECRET/);
  assert.equal(readConfig({ DATABASE_URL: 'postgres://localhost/callzo', WEBHOOK_SECRET: secret,
    API_KEY: 'test-only-key-with-at-least-32-characters' }).webhookSecret, secret);
});
