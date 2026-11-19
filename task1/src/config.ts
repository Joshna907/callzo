// Reject broken configuration before starting the HTTP server.
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must be a Postgres connection URL');
  }

  const webhookSecret = env.WEBHOOK_SECRET;
  if (!webhookSecret?.trim()) throw new Error('WEBHOOK_SECRET is required');

  const apiKey = env.API_KEY;
  if (!apiKey || apiKey.length < 32 || !/^[A-Za-z0-9._~+/-]+=*$/.test(apiKey)) {
    throw new Error('API_KEY must be a bearer-compatible token of at least 32 characters');
  }
  if (apiKey === webhookSecret) throw new Error('API_KEY must differ from WEBHOOK_SECRET');

  const monthlyCapCents = env.MONTHLY_CAP_CENTS ?? '500';
  if (!/^(0|[1-9]\d{0,18})$/.test(monthlyCapCents) || BigInt(monthlyCapCents) > 9223372036854775807n) {
    throw new Error('MONTHLY_CAP_CENTS must be a nonnegative integer no larger than 9223372036854775807');
  }

  return { port, databaseUrl, webhookSecret, apiKey, monthlyCapCents };
}
