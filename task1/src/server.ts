import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createEventReceiver } from './db/events.js';
import { createUsageReader } from './usage/service.js';
import { startWorker } from './jobs/worker.js';

const config = readConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
pool.on('error', () => {
  console.error(JSON.stringify({ level: 'error', event: 'database_connection_error' }));
});

try {
  await migrate(pool);
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'database_migration_failed' }));
  await pool.end();
  process.exit(1);
}

const worker = startWorker(pool);
const app = createApp(async () => {
  await pool.query('SELECT 1 FROM monthly_usage LIMIT 0');
  await pool.query('SELECT 1 FROM usage_jobs LIMIT 0');
}, {
  secret: config.webhookSecret,
  receiveEvent: createEventReceiver(pool),
}, {
  apiKey: config.apiKey,
  monthlyCapCents: config.monthlyCapCents,
  readUsage: createUsageReader(pool),
});
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_started', port: config.port }));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(async () => {
    try {
      await worker.stop();
      await pool.end();
      clearTimeout(timeout);
    } catch {
      process.exitCode = 1;
    }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
