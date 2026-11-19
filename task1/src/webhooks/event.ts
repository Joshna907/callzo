import { z } from 'zod';

// Validate at runtime: TypeScript alone cannot check data sent over HTTP.
const identifier = z.string().min(1).max(255).refine((value) => value.trim().length > 0, 'Must not be blank');

export const callEventSchema = z.object({
  event_id: identifier,
  event_type: z.enum(['call.started', 'call.ended', 'call.failed']),
  account_id: identifier,
  call_id: identifier,
  timestamp: z.iso.datetime({ offset: true }),
  duration_seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cost_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  destination_country: z.string().trim().min(1).max(32),
}).superRefine((event, ctx) => {
  if (event.event_type !== 'call.ended') {
    for (const field of ['duration_seconds', 'cost_cents'] as const) {
      if (event[field] !== 0) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'Must be zero unless the call ended' });
      }
    }
  }
});

export type CallEvent = z.infer<typeof callEventSchema>;
