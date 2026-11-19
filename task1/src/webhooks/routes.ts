import { Hono } from 'hono';
import { callEventSchema, type CallEvent } from './event.js';
import { isSignatureFormatValid, verifySignature } from './signature.js';
import { EventConflictError, type ReceiveResult } from '../db/events.js';

const MAX_BODY_BYTES = 16 * 1024;

export interface WebhookOptions {
  secret: string;
  // Resolve only after durable storage.
  receiveEvent: (event: CallEvent, rawBody: Uint8Array) => Promise<ReceiveResult>;
}

export function createWebhookRoutes(options: WebhookOptions) {
  const routes = new Hono();
  routes.post('/calls', async (c) => {
    const signature = c.req.header('X-Signature');
    if (!isSignatureFormatValid(signature)) {
      return c.json({ error: 'Invalid or missing signature' }, 401);
    }

    // Count actual bytes, including when Content-Length is absent or inaccurate.
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            return c.json({ error: 'Request body exceeds 16 KiB' }, 413);
          }
          chunks.push(value);
        }
      } catch {
        return c.json({ error: 'Could not read request body' }, 400);
      } finally {
        reader.releaseLock();
      }
    }
    const rawBody = Buffer.concat(chunks, size);
    if (!verifySignature(rawBody, signature, options.secret)) {
      return c.json({ error: 'Invalid or missing signature' }, 401);
    }

    // Parsing must happen AFTER signature verification, using the same bytes.
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      return c.json({ error: 'Body must contain valid UTF-8 JSON' }, 400);
    }
    const result = callEventSchema.safeParse(payload);
    if (!result.success) {
      return c.json({
        error: 'Invalid call event',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'), message: issue.message,
        })),
      }, 422);
    }

    // Never acknowledge delivery before we can safely retain the event.
    try {
      const status = await options.receiveEvent(result.data, rawBody);
      return c.json({ status, event_id: result.data.event_id }, status === 'duplicate' ? 200 : 202);
    } catch (error) {
      if (error instanceof EventConflictError) {
        return c.json({ error: error.message, event_id: result.data.event_id }, 409);
      }
      console.error(JSON.stringify({ level: 'error', event: 'event_storage_failed' }));
      return c.json({ error: 'Event storage unavailable; retry delivery' }, 503);
    }
  });
  return routes;
}
