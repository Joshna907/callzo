# Callzo usage metering service

## Task 1: usage metering service

TypeScript + Hono on Node.js, with Postgres accessed through `pg`.
The webhook route verifies signatures, validates events, and stores them in
Postgres before acknowledging delivery. Duplicate IDs with identical JSON
content are acknowledged without inserting again. Changed content with an
existing ID is rejected. Postgres views derive call state and monthly usage
from the stored events. An administrator bearer key protects the usage API,
which reports the per-account monthly soft spending cap. A durable background
queue maintains audit checkpoints with retries, and reconciliation can check or
rebuild those checkpoints from raw events. A complete Docker verification
command exercises native Postgres, the supplied simulator, and live HTTP routes.
The complete verification passed on 10 November 2026; see `VERIFICATION.md`
for the observed results and reproducible commands.

## Run with Docker

Start Docker Desktop in Linux-container mode. From this folder, generate
local configuration and start the project:

```sh
npm run setup
docker compose up --build
```

Open `http://localhost:8000/health` for application liveness, or
`http://localhost:8000/ready` to check the database connection. Readiness
returns HTTP 503 when the database cannot be reached. Postgres data persists
in a named volume; it is not exposed on a host port.
The API applies versioned migrations before listening for requests. A failed
migration stops startup. Readiness checks that the monthly usage view is accessible.
Compose waits for Postgres readiness before starting the API, and API readiness
before starting the simulator. Once images exist, `docker compose up` is enough.
The simulator runs its `all` scenario once and exits; the API/database keep running.
Additional simulator runs may generate new calls and add usage to the same volume.
`API_PORT` can change the host port; it defaults to 8000.

The database credentials in Compose are disposable local-development values,
not production credentials. Real deployment credentials must be injected.
Never commit real secrets or `.env` files.

`npm run setup` creates `.env` from the template if needed and generates a
random 32-byte API key without printing it. Existing nonempty keys are preserved.
No dependency installation is needed for this command. `.env` is ignored by Git
and excluded from Docker's build context. Compose injects its values at runtime.
`.env.example` has an intentionally empty API key; application startup rejects
missing, short, or invalid tokens. If generating config manually, use a random
bearer-compatible token of at least 32 characters, distinct from the webhook secret.

## Supplied simulator

The supplied `meetrj/callzo-webhook-simulator` image currently publishes Linux
ARM64 only (verified from its manifest). Compose explicitly selects `linux/arm64`
so Docker Desktop can emulate it on x86 PCs. API and Postgres use their native
platform. `SIMULATOR_PLATFORM` can override the selection if the provided image
adds another platform. Docker installations without ARM emulation must enable it
or run the simulator on an ARM64 host.

The default scenario is `all`. To run one scenario against an already-running API:

```sh
docker compose run --rm simulator --url http://api:8000/webhooks/calls --scenario duplicates
```

Available scenarios: `normal`, `duplicates`, `out_of_order`, `late`, `malformed`,
`bad_signature`, and `cap_burst`. `SIMULATOR_SCENARIO` changes the default scenario
used by `docker compose up`. The supplied simulator signs with the public
assessment secret in `.env.example`; keep this value for assessment testing.

After a run, inspect the database using the commands below and query the
authenticated usage API. Expected outcomes:

| Scenario | What to inspect |
| --- | --- |
| normal | Ended calls and their supplied seconds/cents in monthly usage |
| duplicates | Repeated delivery gets 200; one event row/job and one call contribution |
| out_of_order | Call remains ended after its start arrives |
| late | Usage appears in the UTC event month, not receipt month |
| malformed | 4xx responses without accepted invalid events or server crashes |
| bad_signature | 401 responses without storing the payload |
| cap_burst | Account reaches/exceeds its cap while all valid usage is retained |

## Full Docker verification

```sh
npm run verify:docker
```

Requires a running Linux Docker engine, registry/network access, and ARM64
emulation for the supplied simulator on x86 hosts. First-time image downloads
can take several minutes. This uses a unique disposable Compose project and
database, an automatically assigned host port, and a 500-cent test cap.
It leaves the regular project's database and containers alone.

The command runs native Postgres integration tests, builds the production API
image, runs the supplied simulator, then performs real HTTP checks using known
fixtures. It verifies authentication, signature rejection, malformed payloads,
duplicates/conflicts, out-of-order/late events, exact cap boundaries, background
queue completion, a deliberate checkpoint-corruption/CLI-repair cycle, API
restart persistence, and a final all-account reconciliation. It also requires
stored simulator events and simulator usage exceeding the test cap.

Known fixtures use isolated `verify_...` account IDs and fixed September/November
2026 months, independently of the simulator's generated data. The command removes
only its own randomly named project containers and test volumes in a finally
block. If interrupted forcibly before cleanup, its project name is visible in
Docker and can be cleaned up explicitly. It does not publish any code or image.

## Local development

```sh
npm ci
```

Generate config with `npm run setup`. Set `DATABASE_URL` to a reachable
Postgres instance, then load the generated `.env` when starting Node.
For example, in PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://user:password@localhost:5432/callzo'
node --env-file=.env --import tsx --watch src/server.ts
```

`PORT` defaults to 8000. `npm run typecheck` checks types; `npm run build`
compiles the source; `npm start` runs the compiled application.
`npm run dev` also works if all required settings are already exported in the
environment; it does not load `.env` automatically.

## Code tour

- `src/config.ts`: validate startup settings.
- `src/app.ts`: HTTP routes and structured request logs.
- `src/server.ts`: database connections, HTTP server, and shutdown.

Each HTTP request gets a generated request ID. Logs omit request bodies,
headers, and query strings. Unknown routes return 404.

## Webhook contract

`POST /webhooks/calls` accepts the event format in the supplied task spec.
`X-Signature` must be a 64-character hexadecimal HMAC-SHA256 signature over
the exact request bytes, using `WEBHOOK_SECRET`. We use Node's constant-time
digest comparison; JSON parsing happens only after verification.

Responses:

| Status | Meaning |
| --- | --- |
| 401 | Missing, malformed, or incorrect signature |
| 413 | Body larger than 16 KiB (actual bytes counted) |
| 400 | Signed body is invalid JSON or UTF-8 |
| 422 | Signed JSON does not match the event schema |
| 202 | New event committed to Postgres; reflected in the usage views |
| 200 | Duplicate delivery, already stored with identical JSON content |
| 409 | Existing event ID was reused with different JSON content |
| 503 | Storage failed; sender should retry the delivery |

Schema rules: required nonempty identifiers, a known event type, a valid ISO
timestamp with timezone, nonnegative safe integer seconds/cents, and zero
seconds/cents for started or failed events. Extra properties are ignored by
validation; the original request bytes are passed to the storage interface.
We do not reject old timestamps: the simulator deliberately sends late events.
Signature verification alone does not prevent replays; Postgres deduplicates
by event ID. The 16 KiB transport limit can reject a request before
checking its signature; no JSON parsing or event processing occurs in that case.

## Storage decisions

`call_events` is the durable event inbox and reconciliation source.
It records the event ID (primary key), type, account/call identifiers, event
timestamp, integer duration/cost, destination, full JSON payload, original
body bytes, and database receipt timestamp. Event time and receipt time are
separate; late and out-of-order events are stored without requiring a start
event to exist first. The `calls` view computes the final state as described below.

`bigint` stores duration and cents without floating-point arithmetic; node-pg
returns these columns as strings to preserve precision. `timestamptz` preserves
the event instant, including the simulator's microsecond precision, because we
pass the original timestamp string rather than converting through a JS Date.
Indexes support account/time and account/call lookups.

The receiver uses parameterized SQL. `INSERT ... ON CONFLICT DO NOTHING`
enforces uniqueness across concurrent requests or API instances. A transaction
commits the event and its `usage_jobs` row together before acknowledging delivery.
If queue insertion fails, the raw insert rolls back too. After a conflict, a
separate query compares JSONB content with the stored event. JSON formatting/key
order do not matter; changed values do. The first delivery's original bytes and
receipt timestamp stay unchanged. Duplicates do not add or reset background jobs.
No application path updates or deletes stored events in this milestone.

If Postgres commits but the HTTP response is lost, retrying is safe: the event
is already stored and the next delivery receives a duplicate acknowledgement.
A 202 means stored; the usage views reflect committed events when queried.
The background worker independently maintains durable usage audit checkpoints.

Schema migrations run inside a transaction with an advisory lock, so parallel
startup does not apply the same migration twice. A version table tracks applied
changes. This works with reused Docker volumes, unlike initialization scripts
that run only when Postgres first creates its data directory.

## Call state and usage rules

Migration 2 adds ordinary SQL views, not independently updated counters:

- `calls`: one row per `(account_id, call_id)`. Ended takes precedence over
  failed, which takes precedence over started. A late start cannot reopen an
  ended or failed call. `started_at` is the earliest reported start, or null
  when none exists. `terminal_at` is the selected ended/failed event's time.
- Multiple events of the winning type are resolved by earliest event timestamp,
  then bytewise event-ID order. This is a deterministic policy for contradictory
  provider reports, not an assumption that every event is a correction. The
  chosen event's ID is visible as `source_event_id`; every raw report is retained.
  A later-arriving earlier end can therefore revise the call's usage/month.
- `monthly_usage`: groups ended calls by account and UTC month of the selected
  end timestamp. It includes `completed_calls`, `duration_seconds`, and
  `cost_cents`. Started/failed calls contribute no usage. Two different event IDs
  reporting the same ended call still contribute only once.
- A cross-month call belongs entirely to its end month, without splitting its
  duration. Late events update their historical month, even if that month is
  old; we have no financial period-closing workflow in this assessment.
- Values are exact integers. Seconds are summed without rounding into billed
  minutes. We use provider-supplied cents, not a rate inferred from duration.
  Postgres SUM(bigint) is numeric, so account totals can exceed JS safe integer
  limits without loss. API totals use decimal strings to preserve exactness.

These views include pre-existing raw events immediately after migration; no
backfill is needed. Every query uses a consistent database snapshot. They cannot
drift from raw events or expose half-updated counters because no separate
counter update occurs. Accounts/months with no ended calls have no summary row;
the usage API returns zero totals for such queries.

Tradeoff: reads rank raw events rather than reading a cached summary table. This
is intentionally simple for the assessment dataset. Larger production workloads
would need measured query performance and potentially transactional materialized
projections for API reads. The background checkpoints below demonstrate durable
processing/retries and reconciliation without making live reads depend on a cache.

To inspect the current calculations after receiving events:

```sh
docker compose exec postgres psql -U callzo -d callzo -c "SELECT * FROM calls;"
docker compose exec postgres psql -U callzo -d callzo -c "SELECT * FROM monthly_usage;"
```

## Authenticated usage API

```http
GET /accounts/acct_001/usage?month=2026-11
Authorization: Bearer <your API_KEY from .env>
```

`month` is optional and defaults to the current UTC month. Its format is
`YYYY-MM`, with years 0001–9999. Blank, repeated, invalid, or unknown query
parameters return 400. Account IDs must be nonblank and at most 255 characters.
An account/month with no ended calls returns zero totals, including accounts
never seen in webhooks: this project has no separate account registry.

Example response (illustrative usage):

```json
{
  "account_id": "acct_001",
  "month": "2026-11",
  "timezone": "UTC",
  "completed_calls": "2",
  "duration_seconds": "300",
  "cost_cents": "10",
  "cap": {
    "type": "soft",
    "limit_cents": "500",
    "remaining_cents": "490",
    "overage_cents": "0",
    "reached": false,
    "exceeded": false,
    "status": "below_limit"
  }
}
```

All counts, durations, and money amounts are decimal strings. Cap arithmetic
uses BigInt without converting totals to JS Number. Responses are marked
`Cache-Control: no-store`. Invalid/missing authentication returns JSON 401 and
a bearer challenge before validation or database access. Database failures
return 503 without exposing connection details. Bearer secrets are compared
through fixed-length SHA-256 digests using constant-time comparison.

Authorization model: the API key is an administrator credential with read
access to every account. It is not a customer login or account-scoped credential.
Webhooks continue to require HMAC signatures, not the administrator key.
Health/readiness remain public. Use HTTPS when deploying beyond local Docker.

## Monthly cap policy

`MONTHLY_CAP_CENTS` defaults to 500 cents. It sets the same soft spending
limit independently for each account and UTC month. Set it in `.env` and
recreate the API container to change it. It must be an unsigned integer in
0–9223372036854775807. There is no cap-update HTTP endpoint in this milestone.

| Usage vs limit | Status | Reached | Exceeded |
| --- | --- | --- | --- |
| Below | below_limit | false | false |
| Equal | at_limit | true | false |
| Above | over_limit | true | true |

Remaining cents stop at zero; overage reports the actual excess. A zero cap
is already reached at zero usage. Incoming valid events are still saved above
the cap, and their costs are never clipped. The soft policy marks the account
as over its monthly limit in the API; it does not stop provider calls, reject
webhooks, send notifications, or pretend a completed call never happened.

Each month starts its own total. Late calls affect their historical month's
cap status. Config changes apply to all months when queried, including history;
we do not snapshot historical limits. Persistent per-account policies and alert
delivery would be production extensions. To exercise the supplied simulator's
cap-burst scenario later, query the affected account/month and check cap status.
The supplied burst produces 40 ten-minute calls at 20 cents each (800 cents
total); the 500-cent default reaches its limit after 25 calls in an otherwise
empty account/month and exceeds it on call 26. Earlier usage can reach it sooner.

## Background retries

The API process starts one background worker after migrations. No Redis or
separate worker container is required. Migration 3 creates durable `usage_jobs`
and queues all events stored before this upgrade.

Each new event commits with one job. The worker claims due jobs using row locks
and `FOR UPDATE SKIP LOCKED`, so multiple API instances can work without claiming
the same job. It rebuilds all `monthly_usage_snapshots` for the affected account
from the raw-event views, then completes the job in the same transaction.
Account advisory locks serialize refreshes and reconciliation for that account.
Different account lock hashes can collide, which only reduces concurrency.

Checkpoint rows are audit copies, not the API's source of truth: live usage/cap
responses continue to read authoritative raw-event views even during worker
failures. Refreshing rather than incrementing is idempotent, handles late events
and changing canonical end reports, and never charges a duplicate twice.

On processing failure, a savepoint rolls back partial checkpoint changes while
retaining the job claim. Attempts are recorded and retries wait 1, 2, 4, then 8
seconds. The fifth failed attempt marks the job `dead`. Failure metadata is a
fixed safe code, never exception text with possible credentials. Completed/dead
jobs stay in the database for inspection. Successful retries clear the error.
An idle worker polls once per second; a database outage is retried on that
interval without falsely completing a job. Such infrastructure failures do not
consume processing attempts if the transaction could not commit.

If the process dies before commit, Postgres rolls back the job and checkpoint
changes; another worker can claim it again. Graceful shutdown stops the worker
before closing the pool. Both HTTP and worker SQL use server-side statement
timeouts, so a client timer cannot leave a query unknowingly running.

Inspect job status:

```sh
docker compose exec postgres psql -U callzo -d callzo -c "SELECT event_id, status, attempts, next_attempt_at, last_error FROM usage_jobs ORDER BY next_attempt_at;"
```

After correcting the cause of an exhausted job, an operator can reset that
specific event's job (replace the illustrative ID):

```sql
UPDATE usage_jobs SET status = 'pending', attempts = 0,
  next_attempt_at = now(), finished_at = NULL, last_error = NULL
WHERE event_id = 'evt_to_retry' AND status = 'dead';
```

Retrying the original webhook does not reset dead work; duplicate event handling
and operational job recovery are deliberately separate.

## Reconciliation

Reconciliation recomputes usage from `call_events` through the same canonical
call/month rules, compares that result with durable checkpoints, and records an
audit run. It detects missing, changed, and extra months. Check mode leaves
checkpoints unchanged; repair atomically replaces the selected account's
checkpoints, including deleting stale months. Raw events are never edited.

```sh
# Check all known accounts (raw events and checkpoint-only accounts).
docker compose exec api node dist/reconcile.js
# Check one account.
docker compose exec api node dist/reconcile.js acct_001
# Rebuild one account's checkpoints, or omit its ID to rebuild all accounts.
docker compose exec api node dist/reconcile.js acct_001 --repair
```

For local development, export `DATABASE_URL` and use
`npm run reconcile -- acct_001 --repair`. The command loads `.env` when present;
it needs database access, not an API key. It validates arguments, runs migrations,
prints structured per-account results and a summary, and exits 0 on success,
2 when check mode finds differences, or 1 on failure. All-account runs commit
one account at a time, not as a global transaction. Audit records are stored
in `reconciliation_runs`.

A transaction-local recomputation fixes the inputs for each comparison/repair;
the account lock excludes concurrent worker/reconciliation writes. Events that
arrive after that computation remain in the durable queue and are included by
a later refresh. A mismatch during active ingestion can therefore be normal
checkpoint lag rather than corruption. Drain pending jobs before using a check
as a strict integrity assertion. Repair does not change pending/dead job status.

Tradeoffs: rebuilding an account for each job favors simple correctness over
throughput. Larger deployments should coalesce account refresh jobs, retain/prune
completed jobs, and alert on queue age/dead work. The worker currently runs with
the API; separating it would allow independent scaling and health monitoring.

## Tests

Run `npm test` using Node's test runner. Webhook boundary tests use
an injected storage function, so they need no running database. They cover
signature verification, raw-byte preservation, malformed data, size limits,
storage failure, duplicate/conflict responses, readiness, and required secret
configuration. Usage tests apply the production migration SQL to PGlite, an
embedded Postgres engine used only as a development dependency. They verify
normal/out-of-order/late calls, duplicate call reports, terminal precedence,
month boundaries/timezones, account isolation, microseconds, integer precision,
existing-event migration compatibility, and rolled-back events. PGlite's single
connection does not test native Postgres concurrency or Docker networking.
`npm run typecheck` checks both application and test sources.
API tests cover authentication before reads, query validation, historical/default
months, empty totals, read failures, exact cap boundaries, zero/large caps, and
startup settings. An embedded-Postgres test drives the real usage reader through
the HTTP handler during a 40-call burst, checks cap transitions, account/month
isolation, and historical updates. Native integration tests also check that
authenticated usage reflects a committed webhook and its duplicate delivery.
Background tests execute production SQL and processing functions in PGlite:
atomic event/job writes, SQL failures after partial writes, delayed retries,
dead jobs, crash rollback, idempotent refreshes, checkpoint corruption, repairs,
historical totals, and integer precision. PGlite tests are single-connection;
native integration tests additionally exercise locked-job skipping and concurrent
workers against a running Postgres server.

Run the separate Postgres tests using a disposable database container:

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -f compose.test.yaml down
```

The test database has no persistent volume or published host port. These tests
exercise actual PostgreSQL migrations, concurrent duplicate/conflicting inserts,
raw-byte persistence, timestamp precision, safe SQL parameters, invalid-event
rejection, reconnection, and storage-unavailable responses. Each test run owns
a randomly named schema and removes only that schema when done.

Alternatively, set `TEST_DATABASE_URL` to a dedicated test database and run
`npm run test:integration`. The test user must be allowed to create schemas.
The command fails clearly when the environment variable is missing.
The individual suites do not run the supplied simulator; `npm run verify:docker`
adds that image and the production HTTP/persistence checks.
