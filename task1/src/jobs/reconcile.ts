import { randomUUID } from 'node:crypto';
import { lockAccount, type JobDatabase } from './checkpoints.js';

// Caller provides a transaction. Worker and reconciliation use the same account lock.
export async function reconcileAccount(database: JobDatabase, accountId: string, repair: boolean) {
  await lockAccount(database, accountId);
  // Freeze one recomputation so comparison and repair refer to identical inputs.
  await database.query(`CREATE TEMP TABLE expected_usage ON COMMIT DROP AS
    SELECT * FROM monthly_usage WHERE account_id = $1`, [accountId]);
  const result = await database.query<{ differing_months: number }>(`
    SELECT count(*)::integer AS differing_months FROM (
      SELECT e.usage_month FROM expected_usage e
      FULL OUTER JOIN (SELECT * FROM monthly_usage_snapshots WHERE account_id = $1) s
        ON e.account_id = s.account_id AND e.usage_month = s.usage_month
      WHERE e.account_id IS NULL OR s.account_id IS NULL OR
        (e.completed_calls, e.duration_seconds, e.cost_cents)
        IS DISTINCT FROM (s.completed_calls, s.duration_seconds, s.cost_cents)
    ) differences`, [accountId]);
  const differingMonths = result.rows[0]!.differing_months;
  if (repair) {
    await database.query('DELETE FROM monthly_usage_snapshots WHERE account_id = $1', [accountId]);
    await database.query(`INSERT INTO monthly_usage_snapshots
      (account_id, usage_month, completed_calls, duration_seconds, cost_cents)
      SELECT account_id, usage_month, completed_calls, duration_seconds, cost_cents FROM expected_usage`);
  }
  const runId = randomUUID();
  await database.query(`INSERT INTO reconciliation_runs (run_id, account_id, mode, differing_months)
    VALUES ($1, $2, $3, $4)`, [runId, accountId, repair ? 'repair' : 'check', differingMonths]);
  await database.query('DROP TABLE expected_usage');
  return { run_id: runId, account_id: accountId, mode: repair ? 'repair' : 'check', differing_months: differingMonths };
}
