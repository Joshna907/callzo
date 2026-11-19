export const sortKeys = ['id', 'name', 'company', 'country', 'plan', 'status', 'signup_date',
  'current_month_minutes', 'current_month_sms', 'cost_cents', 'last_active'] as const;
export type SortKey = typeof sortKeys[number];
export interface Query {
  page: number; page_size: number; search: string; status: string; country: string; plan: string;
  date_from: string; date_to: string; sort_by: SortKey; sort_dir: 'asc' | 'desc';
}
export function validDate(value: string) {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
export function readQuery(search: string): Query {
  const params = new URLSearchParams(search);
  const page = Number(params.get('page') ?? 1);
  const size = Number(params.get('page_size') ?? 25);
  const date_from = params.get('date_from') ?? '';
  const date_to = params.get('date_to') ?? '';
  const sort = params.get('sort_by');
  const from = validDate(date_from) ? date_from : '';
  const to = validDate(date_to) ? date_to : '';
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    page_size: [10, 25, 50, 100].includes(size) ? size : 25,
    search: (params.get('search') ?? '').slice(0, 200),
    status: ['active', 'trial', 'suspended'].includes(params.get('status') ?? '') ? params.get('status')! : '',
    plan: ['basic', 'pro', 'enterprise'].includes(params.get('plan') ?? '') ? params.get('plan')! : '',
    country: /^[A-Z]{2}$/.test(params.get('country') ?? '') ? params.get('country')! : '',
    date_from: from && to && from > to ? '' : from,
    date_to: from && to && from > to ? '' : to,
    sort_by: sortKeys.includes(sort as SortKey) ? sort as SortKey : 'current_month_minutes',
    sort_dir: params.get('sort_dir') === 'asc' ? 'asc' : 'desc',
  };
}
export function tableParams(query: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== '') params.set(key, String(value));
  return params.toString();
}
export function summaryParams(query: Pick<Query, 'date_from' | 'date_to'>) {
  const params = new URLSearchParams();
  if (query.date_from) params.set('date_from', query.date_from);
  if (query.date_to) params.set('date_to', query.date_to);
  return params.toString();
}
export function togglePageSelection(selected: Set<number>, pageIds: number[]) {
  const next = new Set(selected);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => next.has(id));
  for (const id of pageIds) allSelected ? next.delete(id) : next.add(id);
  return next;
}
