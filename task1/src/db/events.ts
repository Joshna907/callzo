import type { CallEvent } from '../webhooks/event.js';

interface EventConnection {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}
export interface EventPool {
  connect(): Promise<EventConnection>;
}

export type ReceiveResult = 'accepted' | 'duplicate';
export class EventConflictError extends Error {
  constructor() { super('Event ID already exists with different content'); }
}

export function createEventReceiver(pool: EventPool) {
  return async (event: CallEvent, rawBody: Uint8Array): Promise<ReceiveResult> => {
    const payload = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The unique key arbitrates concurrent deliveries in Postgres.
      // Event storage and its durable background job must commit together.
      const inserted = await client.query(`
        INSERT INTO call_events (
          event_id, event_type, account_id, call_id, occurred_at,
          duration_seconds, cost_cents, destination_country, payload, raw_body
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `, [event.event_id, event.event_type, event.account_id, event.call_id,
        event.timestamp, event.duration_seconds, event.cost_cents,
        event.destination_country, payload, Buffer.from(rawBody)]);
      if (inserted.rows.length === 1) {
        await client.query('INSERT INTO usage_jobs (event_id) VALUES ($1)', [event.event_id]);
        await client.query('COMMIT');
        return 'accepted';
      }

      // A separate statement sees the concurrent winner after ON CONFLICT waits.
      // JSONB equality ignores whitespace and object-key order, not changed values.
      const existing = await client.query<{ matches: boolean }>(
        'SELECT payload = $2::jsonb AS matches FROM call_events WHERE event_id = $1',
        [event.event_id, payload],
      );
      if (existing.rows[0]?.matches) {
        await client.query('COMMIT');
        return 'duplicate';
      }
      throw new EventConflictError();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}
