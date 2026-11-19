// Minimal query interface allows the same SQL to be exercised in embedded Postgres.
export interface JobDatabase {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function lockAccount(database: JobDatabase, accountId: string) {
  // Namespace this lock separately from schema migrations.
  await database.query('SELECT pg_advisory_xact_lock(736202, hashtext($1))', [accountId]);
}

export async function refreshCheckpoints(database: JobDatabase, accountId: string) {
  await lockAccount(database, accountId);
  await database.query('DELETE FROM monthly_usage_snapshots WHERE account_id = $1', [accountId]);
  await database.query(`INSERT INTO monthly_usage_snapshots
    (account_id, usage_month, completed_calls, duration_seconds, cost_cents)
    SELECT account_id, usage_month, completed_calls, duration_seconds, cost_cents
    FROM monthly_usage WHERE account_id = $1`, [accountId]);
}
