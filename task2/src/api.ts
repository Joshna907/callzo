export interface Account {
  id: number; name: string; email: string; company: string; country: string;
  plan: 'basic' | 'pro' | 'enterprise'; status: 'active' | 'trial' | 'suspended';
  signup_date: string; current_month_minutes: number; current_month_sms: number;
  cost_cents: number; last_active: string;
}
export interface AccountPage { data: Account[]; total: number; page: number; page_size: number }
export interface SummaryPoint { date: string; minutes: number; sms: number; cost_cents: number; signups: number }
export interface Summary { series: SummaryPoint[]; total_accounts: number }
export function stabilizeAccounts(previous: AccountPage, next: AccountPage): AccountPage {
  const incoming = new Map(next.data.map((account) => [account.id, account]));
  const data: Account[] = [];
  for (const account of previous.data) {
    const fresh = incoming.get(account.id);
    if (fresh) { data.push(fresh); incoming.delete(account.id); }
  }
  return { ...next, data: [...data, ...incoming.values()] };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function isAccount(value: unknown): value is Account {
  return record(value) && integer(value.id) &&
    ['name', 'email', 'company', 'country', 'signup_date', 'last_active'].every((key) => typeof value[key] === 'string') &&
    ['basic', 'pro', 'enterprise'].includes(String(value.plan)) &&
    ['active', 'trial', 'suspended'].includes(String(value.status)) &&
    ['current_month_minutes', 'current_month_sms', 'cost_cents'].every((key) => integer(value[key]));
}
export function decodeAccounts(value: unknown): AccountPage {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(isAccount) ||
      !integer(value.total) || !integer(value.page) || !integer(value.page_size) || value.page < 1 || value.page_size < 1) {
    throw new Error('The account service returned an unexpected response.');
  }
  return value as unknown as AccountPage;
}
export function decodeAccount(value: unknown): Account {
  if (!isAccount(value)) throw new Error('The account response was invalid.');
  return value;
}
export function decodeSummary(value: unknown): Summary {
  if (!record(value) || !integer(value.total_accounts) || !Array.isArray(value.series) ||
      !value.series.every((point) => record(point) && typeof point.date === 'string' &&
        ['minutes', 'sms', 'cost_cents', 'signups'].every((key) => integer(point[key])))) {
    throw new Error('The usage service returned an unexpected response.');
  }
  return value as unknown as Summary;
}
export async function getJson<T>(path: string, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  if (!response.ok) throw new Error(`The service could not complete this request (HTTP ${response.status}).`);
  return decode(await response.json());
}
