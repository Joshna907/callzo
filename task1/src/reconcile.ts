import pg from 'pg';
import { migrate } from './db/migrate.js';
import { reconcileAccount } from './jobs/reconcile.js';

const args = process.argv.slice(2);
const repair = args.includes('--repair');
const accounts = args.filter((arg) => arg !== '--repair');
if (args.filter((arg) => arg === '--repair').length > 1 || accounts.length > 1 ||
    accounts.some((arg) => arg.startsWith('-') || !arg.trim() || arg.length > 255)) {
  console.error('Usage: reconcile [account_id] [--repair]. Omit account_id to check all accounts.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000, statement_timeout: 30000 });
try {
  await migrate(pool);
  const accountIds = accounts.length ? accounts : (await pool.query<{ account_id: string }>(`
    SELECT account_id FROM call_events UNION SELECT account_id FROM monthly_usage_snapshots
    ORDER BY account_id`)).rows.map((row) => row.account_id);
  let differences = false;
  let differingMonths = 0;
  for (const accountId of accountIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await reconcileAccount(client, accountId!, repair);
      await client.query('COMMIT');
      differences ||= result.differing_months > 0;
      differingMonths += result.differing_months;
      console.log(JSON.stringify({ event: 'usage_reconciliation', ...result }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  console.log(JSON.stringify({ event: 'reconciliation_complete', accounts_checked: accountIds.length,
    mode: repair ? 'repair' : 'check', differing_months: differingMonths }));
  // Check mode reports drift to scripts; repair mode succeeds after rebuilding.
  if (differences && !repair) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'reconciliation_failed' }));
  process.exitCode = 1;
} finally { await pool.end(); }
