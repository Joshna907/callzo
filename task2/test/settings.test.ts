import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsEditor, SettingsError, validateStep, initialDraft, type SavedSteps, type Step, type StepData } from '../src/settings-model.ts';
import { decodeSettings } from '../src/settings-api.ts';
import type { Account } from '../src/api.ts';

const account: Account = { id: 9, name: 'Test Account', email: 'test@example.com', company: 'Example', country: 'US',
  plan: 'pro', status: 'active', signup_date: '2026-01-01', last_active: '2026-11-01', current_month_minutes: 10, current_month_sms: 2, cost_cents: 50 };
const saved: SavedSteps = { 1: { name: 'Saved Name', email: 'saved@example.com' },
  2: { plan: 'pro', billing_country: 'US' }, 3: {}, 4: { webhook_url: 'https://example.com/hook' } };
function setup(initial: SavedSteps = {}) {
  const calls: { step: Step; data: StepData }[] = [];
  let submitted = 0;
  const transport = { save: async (step: Step, data: StepData) => { calls.push({ step, data }); return data; }, submit: async () => { submitted++; } };
  return { editor: new SettingsEditor(account, initial, transport), transport, calls, submitted: () => submitted };
}

test('saved drafts restore every step and optional blanks remain blank', () => {
  const { editor } = setup(saved);
  assert.equal(editor.getSnapshot().draft.name, 'Saved Name');
  assert.equal(editor.getSnapshot().draft.webhook_url, 'https://example.com/hook');
  assert.equal(editor.getSnapshot().draft.minutes_cap, '');
  for (const step of [1, 2, 3, 4] as const) assert.equal(editor.isDirty(step), false);
});
test('validation rejects invalid fields and accepts optional fields', () => {
  const draft = initialDraft(account);
  assert.ok(validateStep(1, { ...draft, email: 'invalid' }).email);
  assert.ok(validateStep(2, { ...draft, billing_country: 'FR' }).billing_country);
  assert.ok(validateStep(3, { ...draft, sms_cap: '-1' }).sms_cap);
  assert.ok(validateStep(4, { ...draft, webhook_url: 'javascript:alert(1)' }).webhook_url);
  assert.deepEqual(validateStep(3, draft), {});
  assert.deepEqual(validateStep(4, draft), {});
});
test('duplicate queued saves of unchanged data issue only one request', async () => {
  const { editor, calls } = setup();
  await Promise.all([editor.save(1), editor.save(1)]);
  assert.equal(calls.length, 1);
});
test('editing during a slow save cannot be overwritten by its old response', async () => {
  let release!: (data: StepData) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const editor = new SettingsEditor(account, {}, {
    save: async (_step, data) => { entered(); return new Promise((resolve) => { release = resolve; }); }, submit: async () => {},
  });
  editor.edit('name', 'First edit');
  const saving = editor.save(1); await started;
  editor.edit('name', 'Newer edit');
  release({ name: 'First edit', email: account.email }); await saving;
  assert.equal(editor.getSnapshot().draft.name, 'Newer edit');
  assert.equal(editor.getSnapshot().confirmed[1]!.name, 'First edit');
  assert.equal(editor.isDirty(1), true);
});
test('network save failure rolls back only that step and retains attempted edits for retry', async () => {
  let fail = true;
  const editor = new SettingsEditor(account, saved, {
    save: async (_step, data) => { if (fail) throw new Error('offline'); return data; }, submit: async () => {},
  });
  editor.edit('name', 'Attempted name'); editor.edit('sms_cap', '123');
  assert.equal(await editor.save(1), false);
  assert.equal(editor.getSnapshot().draft.name, 'Saved Name');
  assert.equal(editor.getSnapshot().draft.sms_cap, '123');
  assert.equal(editor.getSnapshot().recovery[1]!.name, 'Attempted name');
  fail = false; await editor.restoreAttempt(1);
  assert.equal(editor.getSnapshot().confirmed[1]!.name, 'Attempted name');
  assert.equal(editor.getSnapshot().recovery[1], undefined);
});
test('failed earlier save preserves a newer local edit', async () => {
  let reject!: (error: Error) => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const editor = new SettingsEditor(account, saved, {
    save: async () => { started(); return new Promise((_resolve, fail) => { reject = fail; }); }, submit: async () => {},
  });
  editor.edit('name', 'Old edit'); const saving = editor.save(1); await ready;
  editor.edit('name', 'Newest edit'); reject(new Error('offline')); await saving;
  assert.equal(editor.getSnapshot().draft.name, 'Newest edit');
});
test('server step-2 validation preserves later steps and restoration permits submission', async () => {
  let submitted = false; let writes = 0;
  const editor = new SettingsEditor(account, saved, {
    save: async (step, data) => {
      writes++;
      if (step === 2) throw new SettingsError('Validation', 422, 2, { billing_country: 'billing_country is required' });
      return data;
    }, submit: async () => { submitted = true; },
  });
  editor.edit('billing_country', 'IN');
  assert.equal(await editor.save(2), false);
  assert.equal(editor.getSnapshot().errors[2]!.billing_country, 'billing_country is required');
  assert.equal(editor.getSnapshot().draft.billing_country, 'IN');
  assert.equal(editor.getSnapshot().draft.webhook_url, 'https://example.com/hook');
  editor.restoreConfirmed(2);
  assert.equal(await editor.finish(), null);
  assert.equal(submitted, true);
  assert.equal(writes, 1, 'Final submit must not re-save unchanged step 2');
});
test('step 4 cannot be saved before a billing draft exists', async () => {
  const { editor, calls } = setup();
  assert.equal(await editor.save(4), false);
  assert.equal(calls.length, 0);
  assert.match(editor.getSnapshot().messages[4]!, /step 2/);
  await editor.save(2);
  assert.equal(await editor.save(4), true);
});
test('final submission saves missing steps in order and does not submit invalid data', async () => {
  const { editor, calls, submitted } = setup();
  assert.equal(await editor.finish(), null);
  assert.deepEqual(calls.map((call) => call.step), [1, 2, 3, 4]);
  assert.equal(submitted(), 1);
  const invalid = setup(); invalid.editor.edit('email', 'invalid');
  assert.equal(await invalid.editor.finish(), 1);
  assert.equal(invalid.submitted(), 0);
});
test('failed final submission retains confirmed drafts and can be retried without extra writes', async () => {
  let fail = true;
  const editor = new SettingsEditor(account, saved, {
    save: async () => { throw new Error('Unchanged drafts must not be re-saved'); },
    submit: async () => { if (fail) throw new SettingsError('temporarily unavailable', 500); },
  });
  assert.equal(await editor.finish(), 4);
  assert.equal(editor.getSnapshot().finalized, false);
  assert.equal(Object.keys(editor.getSnapshot().confirmed).length, 4);
  fail = false; assert.equal(await editor.finish(), null);
  assert.equal(editor.getSnapshot().finalized, true);
});
test('browser backup preserves pending edits separately from server-confirmed data', () => {
  const { editor, transport } = setup(saved);
  editor.edit('name', 'Browser pending name');
  const restored = new SettingsEditor(account, saved, transport, editor.backup());
  assert.equal(restored.getSnapshot().draft.name, 'Browser pending name');
  assert.equal(restored.getSnapshot().confirmed[1]!.name, 'Saved Name');
});

test('missing server drafts are saved again after a rejected final submission', async () => {
  let first = true;
  const writes: Step[] = [];
  const editor = new SettingsEditor(account, saved, {
    save: async (step, data) => { writes.push(step); return data; },
    submit: async () => {
      if (first) { first = false; throw new SettingsError('Missing steps', 400, undefined, {}, [1, 2, 3, 4]); }
    },
  });
  assert.equal(await editor.finish(), 1);
  assert.equal(editor.getSnapshot().draft.name, 'Saved Name');
  assert.equal(await editor.finish(), null);
  assert.deepEqual(writes, [1, 2, 3, 4]);
  assert.equal(editor.getSnapshot().finalized, true);
});
test('draft decoding strips unknown fields and rejects malformed payloads', () => {
  assert.deepEqual(decodeSettings({ 1: { name: 'A', email: 'a@b', ignored: 'value' }, 3: { minutes_cap: null } }), { 1: { name: 'A', email: 'a@b' }, 3: {} });
  assert.throws(() => decodeSettings({ 1: [] }));
  assert.throws(() => decodeSettings({ 3: { minutes_cap: {} } }));
});
