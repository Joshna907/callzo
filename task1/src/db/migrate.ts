import type { Pool } from 'pg';

export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE call_events (
      event_id text PRIMARY KEY,
      event_type text NOT NULL CHECK (event_type IN ('call.started', 'call.ended', 'call.failed')),
      account_id text NOT NULL,
      call_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      duration_seconds bigint NOT NULL CHECK (duration_seconds BETWEEN 0 AND 9007199254740991),
      cost_cents bigint NOT NULL CHECK (cost_cents BETWEEN 0 AND 9007199254740991),
      destination_country text NOT NULL,
      payload jsonb NOT NULL,
      raw_body bytea NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CHECK (event_type = 'call.ended' OR (duration_seconds = 0 AND cost_cents = 0))
    );
    CREATE INDEX call_events_account_occurred_idx ON call_events (account_id, occurred_at);
    CREATE INDEX call_events_call_idx ON call_events (account_id, call_id);
  `,
}, {
  version: 2,
  sql: `
    -- One canonical record per account/call, derived from immutable raw events.
    CREATE VIEW calls AS
    WITH ranked AS (
      SELECT e.*,
        min(occurred_at) FILTER (WHERE event_type = 'call.started')
          OVER (PARTITION BY account_id, call_id) AS started_at,
        row_number() OVER (
          PARTITION BY account_id, call_id
          ORDER BY CASE event_type
            WHEN 'call.ended' THEN 0 WHEN 'call.failed' THEN 1 ELSE 2 END,
            occurred_at ASC, event_id COLLATE "C" ASC
        ) AS position
      FROM call_events e
    )
    SELECT account_id, call_id,
      CASE event_type WHEN 'call.ended' THEN 'ended'
        WHEN 'call.failed' THEN 'failed' ELSE 'started' END AS state,
      started_at,
      CASE WHEN event_type <> 'call.started' THEN occurred_at END AS terminal_at,
      event_id AS source_event_id,
      duration_seconds, cost_cents, destination_country,
      CASE WHEN event_type = 'call.ended'
        THEN date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date
      END AS usage_month
    FROM ranked WHERE position = 1;

    CREATE VIEW monthly_usage AS
    SELECT account_id, usage_month,
      count(*) AS completed_calls,
      sum(duration_seconds) AS duration_seconds,
      sum(cost_cents) AS cost_cents
    FROM calls WHERE state = 'ended'
    GROUP BY account_id, usage_month;
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE monthly_usage_snapshots (
      account_id text NOT NULL,
      usage_month date NOT NULL,
      completed_calls bigint NOT NULL CHECK (completed_calls >= 0),
      duration_seconds numeric NOT NULL CHECK (duration_seconds >= 0 AND scale(duration_seconds) = 0),
      cost_cents numeric NOT NULL CHECK (cost_cents >= 0 AND scale(cost_cents) = 0),
      refreshed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, usage_month)
    );
    CREATE TABLE usage_jobs (
      event_id text PRIMARY KEY REFERENCES call_events(event_id),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'dead')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      last_error text
    );
    CREATE INDEX usage_jobs_due_idx ON usage_jobs (next_attempt_at, event_id) WHERE status = 'pending';
    INSERT INTO usage_jobs (event_id) SELECT event_id FROM call_events;
    CREATE TABLE reconciliation_runs (
      run_id uuid PRIMARY KEY,
      account_id text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('check', 'repair')),
      differing_months integer NOT NULL CHECK (differing_months >= 0),
      checked_at timestamptz NOT NULL DEFAULT now()
    );
  `,
}];

// Run on every startup, including when an existing Docker volume is reused.
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    // Serialize migrations across API instances; released on commit/rollback.
    await client.query('SELECT pg_advisory_xact_lock(736201)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const migration of migrations) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [migration.version]);
      if (existing.rowCount) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
