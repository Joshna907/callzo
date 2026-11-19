import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createWebhookRoutes, type WebhookOptions } from './webhooks/routes.js';
import { createUsageRoutes, type UsageOptions } from './usage/routes.js';

// Pass in the database check so HTTP handling stays separate from connections.
export function createApp(checkDatabase: () => Promise<void>, webhook: WebhookOptions, usage?: UsageOptions) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const start = performance.now();
    c.header('X-Request-Id', requestId);
    await next();
    // Do not log headers, bodies, or query strings: these can contain secrets.
    console.log(JSON.stringify({
      level: 'info', event: 'http_request', request_id: requestId,
      method: c.req.method, path: c.req.path, status: c.res.status,
      duration_ms: Math.round(performance.now() - start),
    }));
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      await checkDatabase();
      return c.json({ status: 'ready', database: 'ok' });
    } catch {
      return c.json({ status: 'not_ready', database: 'unavailable' }, 503);
    }
  });
  app.route('/webhooks', createWebhookRoutes(webhook));
  if (usage) app.route('/accounts', createUsageRoutes(usage));
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError(() => {
    console.error(JSON.stringify({ level: 'error', event: 'request_failed' }));
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  });

  return app;
}
