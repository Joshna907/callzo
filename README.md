# Callzo engineering assessment

- [Task 1](task1/README.md): TypeScript, Hono, Postgres usage metering, signed webhooks, durable jobs, reconciliation, authenticated usage API.
- [Task 2](task2/README.md): React, Tailwind, Chart.js console with server pagination, filters, polling, selection, and four-step autosaved settings.

## Run

Task 1: `cd task1`, `npm run setup`, then `docker compose up --build` (API localhost:8000).

Task 2: `cd task2`, then `docker compose up -d --wait` (console http://localhost:3000). The submitted Compose uses the public frontend image; no source build is required. Docker Desktop needs ARM64 emulation for the supplied API/simulator images.

## Verification and walkthrough

[Task 1 results](task1/VERIFICATION.md), [Task 2 results](task2/VERIFICATION.md). Task 1 has 46 unit tests and 12 native Postgres integration tests; Task 2 has 20 tests. Browser verification limits are documented honestly.

For the walkthrough, explain HMAC/raw bytes, idempotency, database transactions, integer cents, soft caps, jobs and reconciliation. Then demonstrate cross-page selection, independent chart failure, autosaved drafts, billing rejection after step 4 and recovery. Task 2 uses the supplied mock independently of Task 1.
