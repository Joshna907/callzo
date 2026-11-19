import { refreshCheckpoints, type JobDatabase } from './checkpoints.js';

export const MAX_ATTEMPTS = 5;
export function retryDelaySeconds(attempt: number) {
  return Math.min(60, 2 ** (attempt - 1));
}

// The caller owns a transaction on a single connection throughout this function.
export async function processNextJob(
  database: JobDatabase,
  refresh: (database: JobDatabase, accountId: string) => Promise<void> = refreshCheckpoints,
) {
  const { rows } = await database.query<{ event_id: string; account_id: string; attempts: number }>(`
    SELECT j.event_id, e.account_id, j.attempts
    FROM usage_jobs j JOIN call_events e USING (event_id)
    WHERE j.status = 'pending' AND j.next_attempt_at <= clock_timestamp()
    ORDER BY j.next_attempt_at, j.event_id COLLATE "C"
    LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  `);
  const job = rows[0];
  if (!job) return null;
  const attempt = job.attempts + 1;
  // Keep the job claim locked while rolling back a failed checkpoint refresh.
  await database.query('SAVEPOINT refresh_work');
  try {
    await refresh(database, job.account_id);
    await database.query('RELEASE SAVEPOINT refresh_work');
  } catch {
    await database.query('ROLLBACK TO SAVEPOINT refresh_work');
    const status = attempt >= MAX_ATTEMPTS ? 'dead' : 'pending';
    await database.query(`UPDATE usage_jobs SET attempts = $2, status = $3,
      next_attempt_at = clock_timestamp() + ($4 * interval '1 second'),
      finished_at = CASE WHEN $3 = 'dead' THEN clock_timestamp() ELSE NULL END,
      last_error = 'checkpoint_refresh_failed' WHERE event_id = $1`,
    [job.event_id, attempt, status, retryDelaySeconds(attempt)]);
    return { event_id: job.event_id, account_id: job.account_id, attempt, status };
  }
  await database.query(`UPDATE usage_jobs SET attempts = $2, status = 'completed',
    finished_at = clock_timestamp(), last_error = NULL WHERE event_id = $1`, [job.event_id, attempt]);
  return { event_id: job.event_id, account_id: job.account_id, attempt, status: 'completed' };
}
