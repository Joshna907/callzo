# Task 1 verification

Reverified 19 November 2026: 46 local tests and typecheck passed. The full Docker verification also passed on 18 November: 12 native Postgres tests, simulator scenarios, live HTTP checks, restart persistence, and final reconciliation with zero differing months. The historical run below records the original baseline; randomized totals vary by run.

Verified on 10 November 2026 using Windows, Docker Desktop's Linux engine,
Node.js 22, Postgres 17 Alpine, and the supplied ARM64 simulator under emulation.

## Results

| Check | Observed result |
| --- | --- |
| `npm test` | 46 tests passed, 0 failed |
| `npm run typecheck` | Application and test types passed |
| `npm run build` | TypeScript compilation passed |
| Native Postgres integration suite | 12 tests passed, 0 failed |
| `npm run verify:docker` | Passed with process exit code 0 |
| Supplied simulator `all` scenario | 158 unique events stored in the disposable run |
| Duplicate deliveries | First delivery 202; subsequent identical deliveries 200 |
| Out-of-order and late events | Accepted; deterministic call state and historical UTC usage |
| Malformed requests | 400 for invalid/empty JSON; 422 for invalid event fields/types |
| Invalid/missing signatures | 401, without processing the event |
| Simulator cap burst | Account `acct_001` had 44 completed November calls costing 828 cents, above the 500-cent limit |
| Known HTTP fixtures | Exact usage totals and below/at/over-cap transitions passed |
| Background processing | Queue drained without dead jobs |
| Deliberately corrupted checkpoint | Check detected differences; CLI repair succeeded; repeat check was clean |
| API restart | Known usage, stored events, and cap state persisted |
| Final reconciliation | 12 accounts checked, 0 differing months |
| Regular Compose startup | API and Postgres healthy; simulator exited successfully |
| Regular project usage API | HTTP 200; `acct_001` reported 824 cents against its 500-cent cap |
| Regular project reconciliation | 10 accounts checked, 0 differing months |

The simulator generates random identifiers and account assignments, so individual
account totals can change between runs. The cap burst itself sends forty 600-second
calls costing 20 cents each. The default cap was adjusted from 1000 to 500 cents
after observing that the 800-cent burst would not cross the earlier default.

The native suite exercised simultaneous duplicate inserts, conflicting payloads,
concurrent migrations, locked-job skipping, competing workers, SQL-safe identifiers,
timestamp precision, and database failure responses. Embedded-Postgres tests
add retry scheduling, partial-failure rollback, exhausted jobs, and reconciliation
damage/repair cases. These are functional checks, not a production load test.

## Reproduce

From `task1`, with Docker Desktop running:

```sh
npm ci
npm test
npm run typecheck
npm run verify:docker
```

The Docker verifier generates local configuration if needed, creates a unique
disposable project, runs native integration tests and the production API image,
executes the supplied simulator and HTTP fixtures, restarts the API, reconciles,
and removes its own containers/volumes. It does not touch regular project data.

For the regular local service:

```sh
npm run setup
docker compose up --build
```

The API listens at `http://localhost:8000`; `/health` and `/ready` are public.
Account usage requires the private administrator key in `.env`.

The supplied simulator currently publishes ARM64 only. Compose sets that platform
explicitly. First-time registry downloads/builds require network access and can be
slow; image downloads took most of this verification's elapsed time.
