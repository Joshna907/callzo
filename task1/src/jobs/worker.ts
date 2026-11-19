import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { processNextJob } from './process.js';

export async function runWorkerOnce(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await processNextJob(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function startWorker(pool: Pool) {
  const controller = new AbortController();
  const running = (async () => {
    while (!controller.signal.aborted) {
      let didWork = false;
      try {
        const result = await runWorkerOnce(pool);
        didWork = result !== null;
        if (result) console.log(JSON.stringify({ level: result.status === 'completed' ? 'info' : 'warn',
          event: 'usage_job', ...result }));
      } catch {
        console.error(JSON.stringify({ level: 'error', event: 'usage_worker_unavailable' }));
      }
      if (!didWork && !controller.signal.aborted) {
        try { await delay(1000, undefined, { signal: controller.signal }); } catch { /* stopping */ }
      }
    }
  })();
  return { stop: async () => { controller.abort(); await running; } };
}
