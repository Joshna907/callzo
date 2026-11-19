export interface UsageTotals {
  completed_calls: string;
  duration_seconds: string;
  cost_cents: string;
}

export interface UsageDatabase {
  query(sql: string, values: string[]): Promise<{ rows: UsageTotals[] }>;
}

export function createUsageReader(database: UsageDatabase) {
  return async (accountId: string, month: string): Promise<UsageTotals> => {
    const result = await database.query(`
      SELECT coalesce(u.completed_calls, 0)::text AS completed_calls,
        coalesce(u.duration_seconds, 0)::text AS duration_seconds,
        coalesce(u.cost_cents, 0)::text AS cost_cents
      FROM (VALUES (1)) AS anchor(n)
      LEFT JOIN monthly_usage u
        ON u.account_id = $1 AND u.usage_month = $2::date
    `, [accountId, `${month}-01`]);
    const totals = result.rows[0];
    if (!totals) throw new Error('Usage query returned no result');
    return totals;
  };
}

export function describeUsage(accountId: string, month: string, totals: UsageTotals, limitCents: string) {
  // Never pass exact database totals through Number or floating-point arithmetic.
  const spent = BigInt(totals.cost_cents);
  const limit = BigInt(limitCents);
  return {
    account_id: accountId,
    month,
    timezone: 'UTC',
    ...totals,
    cap: {
      type: 'soft',
      limit_cents: limit.toString(),
      remaining_cents: (spent < limit ? limit - spent : 0n).toString(),
      overage_cents: (spent > limit ? spent - limit : 0n).toString(),
      reached: spent >= limit,
      exceeded: spent > limit,
      status: spent < limit ? 'below_limit' : spent === limit ? 'at_limit' : 'over_limit',
    },
  };
}
