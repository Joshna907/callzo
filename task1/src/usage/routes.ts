import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { describeUsage, type UsageTotals } from './service.js';

export interface UsageOptions {
  apiKey: string;
  monthlyCapCents: string;
  readUsage: (accountId: string, month: string) => Promise<UsageTotals>;
  now?: () => Date;
}

const accountSchema = z.string().min(1).max(255).refine((id) => id.trim().length > 0);
const monthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);

export function createUsageRoutes(options: UsageOptions) {
  const routes = new Hono();
  const expected = createHash('sha256').update(options.apiKey).digest();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(c.req.header('Authorization') ?? '');
    // Compare fixed-length hashes rather than variable-length secret strings.
    const authorized = match?.[1] !== undefined && timingSafeEqual(
      expected, createHash('sha256').update(match[1]).digest(),
    );
    if (!authorized) {
      c.header('WWW-Authenticate', 'Bearer realm="usage"');
      return c.json({ error: 'A valid bearer API key is required' }, 401);
    }
    await next();
  });

  routes.get('/:accountId/usage', async (c) => {
    const accountId = c.req.param('accountId');
    const params = new URL(c.req.url).searchParams;
    if (!accountSchema.safeParse(accountId).success ||
        [...params.keys()].some((key) => key !== 'month') || params.getAll('month').length > 1) {
      return c.json({ error: 'Provide an account ID and at most one month parameter' }, 400);
    }
    const month = params.get('month') ?? (options.now?.() ?? new Date()).toISOString().slice(0, 7);
    if (!monthSchema.safeParse(month).success) {
      return c.json({ error: 'month must be YYYY-MM with year 0001–9999 and month 01–12' }, 400);
    }
    try {
      const totals = await options.readUsage(accountId, month);
      return c.json(describeUsage(accountId, month, totals, options.monthlyCapCents));
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'usage_read_failed' }));
      return c.json({ error: 'Usage temporarily unavailable; retry later' }, 503);
    }
  });
  return routes;
}
