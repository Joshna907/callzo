import { decodeAccount } from './api.ts';
import { SettingsError, steps, stepFields, type BrowserBackup, type Draft, type SavedSteps, type Step, type StepData } from './settings-model.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function decodeSettings(value: unknown): SavedSteps {
  if (!object(value)) throw new Error('The saved draft response was invalid.');
  const saved: SavedSteps = {};
  for (const step of steps) {
    const data = value[String(step)];
    if (data === undefined) continue;
    if (!object(data)) throw new Error('A saved draft step was invalid.');
    const clean: StepData = {};
    for (const field of stepFields[step]) {
      const item = data[field];
      if (item === undefined || item === null) continue;
      if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) throw new Error('A saved field was invalid.');
      clean[field] = item;
    }
    saved[step] = clean;
  }
  return saved;
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = object(body) ? body.detail : undefined;
    const step = object(detail) && steps.includes(detail.step as Step) ? detail.step as Step : undefined;
    const fields: Record<string, string> = {};
    if (object(detail) && object(detail.errors)) for (const [field, message] of Object.entries(detail.errors)) {
      if (typeof message === 'string') fields[field] = message;
    }
    const missing = object(detail) && Array.isArray(detail.missing_steps) ? detail.missing_steps.filter((value): value is Step => steps.includes(value as Step)) : [];
    throw new SettingsError(response.status === 404 ? 'This account could not be found.'
      : response.status === 422 ? 'Review the highlighted fields.'
      : response.status === 400 ? 'Some steps have not been saved. Review each step and retry.'
      : `The service is unavailable (HTTP ${response.status}). Your saved draft is preserved.`, response.status, step, fields, missing);
  }
  return body;
}
export async function loadSettings(accountId: number, signal: AbortSignal) {
  const [account, saved] = await Promise.all([
    request(`/accounts/${accountId}`, { signal }), request(`/accounts/${accountId}/settings`, { signal }),
  ]);
  return { account: decodeAccount(account), saved: decodeSettings(saved) };
}
export function settingsTransport(accountId: number) {
  return {
    async save(step: Step, data: StepData) {
      const body = await request(`/accounts/${accountId}/settings/step/${step}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
      });
      if (!object(body) || body.saved !== true || body.step !== step) throw new Error('Save was not confirmed by the service.');
      return decodeSettings({ [step]: body.data })[step]!;
    },
    async submit() { await request(`/accounts/${accountId}/settings/submit`, { method: 'POST' }); },
  };
}
export function readBrowserBackup(id: number): BrowserBackup | undefined {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(`callzo-settings-${id}`) ?? 'null');
    if (!object(raw) || !object(raw.pending) || !object(raw.recovery)) return;
    const pending: BrowserBackup['pending'] = {};
    for (const step of steps) {
      const data = raw.pending[String(step)];
      if (!object(data)) continue;
      const fields: Partial<Draft> = {};
      for (const field of stepFields[step]) if (typeof data[field] === 'string' && data[field].length <= 4096) fields[field] = data[field];
      pending[step] = fields;
    }
    return { pending, recovery: decodeSettings(raw.recovery) };
  } catch { return; }
}
