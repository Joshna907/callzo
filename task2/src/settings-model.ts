import type { Account } from './api.ts';

export const steps = [1, 2, 3, 4] as const;
export type Step = typeof steps[number];
export type Draft = Record<'name' | 'email' | 'plan' | 'billing_country' | 'minutes_cap' | 'sms_cap' | 'webhook_url', string>;
export type Field = keyof Draft;
export type StepData = Record<string, string | number>;
export type SavedSteps = Partial<Record<Step, StepData>>;
export type FieldErrors = Record<string, string>;
export const stepFields: Record<Step, Field[]> = {
  1: ['name', 'email'], 2: ['plan', 'billing_country'], 3: ['minutes_cap', 'sms_cap'], 4: ['webhook_url'],
};
export interface SettingsTransport {
  save(step: Step, data: StepData): Promise<StepData>;
  submit(): Promise<void>;
}
export class SettingsError extends Error {
  status: number; step?: Step; fields: FieldErrors; missing: Step[];
  constructor(message: string, status = 0, step?: Step, fields: FieldErrors = {}, missing: Step[] = []) {
    super(message); this.status = status; this.step = step; this.fields = fields; this.missing = missing;
  }
}
export interface EditorSnapshot {
  draft: Draft; confirmed: SavedSteps; errors: Partial<Record<Step, FieldErrors>>;
  messages: Partial<Record<Step, string>>; recovery: SavedSteps;
  saving: Step | null; submitting: boolean; finalized: boolean; revision: number;
}
export interface BrowserBackup { pending: Partial<Record<Step, Partial<Draft>>>; recovery: SavedSteps }

export function initialDraft(account: Account): Draft {
  return { name: account.name, email: account.email, plan: account.plan,
    billing_country: ['US', 'IN', 'GB', 'CA', 'AU'].includes(account.country) ? account.country : '',
    minutes_cap: '', sms_cap: '', webhook_url: '' };
}
export function applyStep(draft: Draft, step: Step, data: StepData): Draft {
  const next = { ...draft };
  for (const field of stepFields[step]) next[field] = data[field] === undefined ? '' : String(data[field]);
  return next;
}
export function stepPayload(step: Step, draft: Draft): StepData {
  const result: StepData = {};
  for (const field of stepFields[step]) {
    if (field === 'minutes_cap' || field === 'sms_cap') {
      if (draft[field].trim() !== '') result[field] = Number(draft[field]);
    } else result[field] = draft[field].trim();
  }
  return result;
}
export function validateStep(step: Step, draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  if (step === 1) {
    if (!draft.name.trim()) errors.name = 'Enter an account name.';
    if (!draft.email.trim() || !draft.email.includes('@')) errors.email = 'Enter an email address containing @.';
  }
  if (step === 2) {
    if (!['basic', 'pro', 'enterprise'].includes(draft.plan)) errors.plan = 'Choose a plan.';
    if (!['US', 'IN', 'GB', 'CA', 'AU'].includes(draft.billing_country)) errors.billing_country = 'Choose a supported billing country.';
  }
  if (step === 3) for (const field of ['minutes_cap', 'sms_cap'] as const) {
    const value = Number(draft[field]);
    if (draft[field].trim() && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) {
      errors[field] = 'Enter a nonnegative number within the supported range, or leave blank.';
    }
  }
  if (step === 4 && draft.webhook_url.trim()) {
    try {
      const url = new URL(draft.webhook_url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { errors.webhook_url = 'Enter a full http:// or https:// URL, or leave blank.'; }
  }
  return errors;
}
const equal = (a: StepData | undefined, b: StepData) => a !== undefined &&
  Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([key, value]) => a[key] === value);

export class SettingsEditor {
  private state: EditorSnapshot;
  private defaults: Draft;
  private versions: Record<Step, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private transport: SettingsTransport;
  constructor(account: Account, saved: SavedSteps, transport: SettingsTransport, backup?: BrowserBackup) {
    this.transport = transport;
    this.defaults = initialDraft(account);
    let draft = { ...this.defaults };
    const confirmed: SavedSteps = {};
    for (const step of steps) if (saved[step]) {
      draft = applyStep(draft, step, saved[step]);
      confirmed[step] = stepPayload(step, draft);
    }
    for (const step of steps) if (backup?.pending[step]) {
      for (const field of stepFields[step]) {
        const value = backup.pending[step]?.[field];
        if (typeof value === 'string') draft[field] = value;
      }
      this.versions[step]++;
    }
    this.state = { draft, confirmed, errors: {}, messages: {}, recovery: backup?.recovery ?? {},
      saving: null, submitting: false, finalized: false, revision: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<EditorSnapshot>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  isDirty(step: Step) { return !equal(this.state.confirmed[step], stepPayload(step, this.state.draft)); }
  hasPendingEdits() { return steps.some((step) => this.isDirty(step) && this.versions[step] > 0) || this.state.saving !== null; }
  edit(field: Field, value: string) {
    const step = steps.find((step) => stepFields[step].includes(field))!;
    this.versions[step]++;
    const errors = { ...this.state.errors, [step]: { ...this.state.errors[step] } };
    delete errors[step]![field];
    const messages = { ...this.state.messages }; const recovery = { ...this.state.recovery };
    delete messages[step]; delete recovery[step];
    this.publish({ draft: { ...this.state.draft, [field]: value }, errors, messages, recovery, finalized: false });
  }
  backup(): BrowserBackup {
    const pending: BrowserBackup['pending'] = {};
    for (const step of steps) if (this.isDirty(step) && this.versions[step] > 0) {
      pending[step] = Object.fromEntries(stepFields[step].map((field) => [field, this.state.draft[field]]));
    }
    return { pending, recovery: this.state.recovery };
  }
  restoreConfirmed(step: Step) {
    const errors = { ...this.state.errors }; const messages = { ...this.state.messages }; const recovery = { ...this.state.recovery };
    delete errors[step]; delete messages[step]; delete recovery[step];
    this.versions[step]++;
    this.publish({ draft: applyStep(this.state.draft, step, this.state.confirmed[step] ?? stepPayload(step, this.defaults)), errors, messages, recovery });
  }
  restoreAttempt(step: Step) {
    const attempt = this.state.recovery[step];
    if (!attempt) return;
    this.versions[step]++;
    this.publish({ draft: applyStep(this.state.draft, step, attempt) });
    return this.save(step);
  }
  save(step: Step): Promise<boolean> {
    const result = this.queue.then(() => this.performSave(step));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async performSave(step: Step): Promise<boolean> {
    if (!this.isDirty(step)) return true;
    const errors = validateStep(step, this.state.draft);
    if (Object.keys(errors).length) {
      this.publish({ errors: { ...this.state.errors, [step]: errors } }); return false;
    }
    if (step === 4 && !this.state.confirmed[2]) {
      this.publish({ messages: { ...this.state.messages, 4: 'Save billing details in step 2 before saving this step.' } }); return false;
    }
    const payload = stepPayload(step, this.state.draft);
    const version = this.versions[step];
    this.publish({ saving: step });
    try {
      const saved = await this.transport.save(step, payload);
      const confirmedDraft = applyStep(this.state.draft, step, saved);
      const confirmed = { ...this.state.confirmed, [step]: stepPayload(step, confirmedDraft) };
      const nextErrors = { ...this.state.errors }; const messages = { ...this.state.messages }; const recovery = { ...this.state.recovery };
      delete nextErrors[step]; delete messages[step]; delete recovery[step];
      this.publish({ confirmed, draft: this.versions[step] === version ? confirmedDraft : this.state.draft,
        saving: null, errors: nextErrors, messages, recovery });
      return true;
    } catch (error) {
      if (error instanceof SettingsError && error.status === 422) {
        const target = error.step ?? step;
        this.publish({ saving: null, errors: { ...this.state.errors, [target]: error.fields },
          messages: { ...this.state.messages, [target]: 'The service rejected this step. Your other steps are preserved.' } });
      } else {
        const unchanged = this.versions[step] === version;
        if (unchanged) this.versions[step]++;
        this.publish({ saving: null,
          draft: unchanged ? applyStep(this.state.draft, step, this.state.confirmed[step] ?? stepPayload(step, this.defaults)) : this.state.draft,
          recovery: { ...this.state.recovery, [step]: payload },
          messages: { ...this.state.messages, [step]: unchanged
            ? 'Save failed. Last confirmed values restored; your attempted edits are available to retry.'
            : 'An earlier save failed. Your newer edits are still here; retry when the connection returns.' } });
      }
      return false;
    }
  }
  async finish(): Promise<Step | null> {
    if (this.state.submitting) return null;
    this.publish({ submitting: true });
    try {
      for (const step of steps) {
        if (this.state.recovery[step] || !(await this.save(step))) return step;
      }
      // Never re-save unchanged steps: step 2 may reject after step 4 exists.
      await this.transport.submit();
      this.publish({ finalized: true });
      return null;
    } catch (error) {
      const target = error instanceof SettingsError ? error.step ?? error.missing[0] ?? 4 : 4;
      const confirmed = { ...this.state.confirmed };
      // A restarted mock service may have forgotten drafts we previously saved.
      // Keep the user's values, but let the next attempt actually save missing steps.
      if (error instanceof SettingsError && error.status === 400) {
        for (const missing of error.missing) { delete confirmed[missing]; this.versions[missing]++; }
      }
      this.publish({ confirmed, errors: { ...this.state.errors, [target]: error instanceof SettingsError ? error.fields : {} },
        messages: { ...this.state.messages, [target]: error instanceof SettingsError ? error.message : 'Final submission failed. Saved drafts are preserved; retry submission.' } });
      return target;
    } finally { this.publish({ submitting: false }); }
  }
}
