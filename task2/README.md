# Usage admin console

React + TypeScript + Tailwind + Chart.js. React/React DOM and Chart.js are the only application libraries. Native fetch, History, Set, browser storage, and hooks handle other behavior.

## Run

```sh
docker compose up -d --wait
```

Open http://localhost:3000. Main Compose references `joshna907/callzo-task2-frontend:v1` without a build directive. Nginx proxies same-origin `/api/` to `http://mock-api:8001/` inside Docker. Ports bind to loopback. The supplied API requires ARM64 emulation on Intel/AMD PCs; frontend supports AMD64 and ARM64.

## Develop

```sh
npm ci
docker compose up -d --wait mock-api
npm run dev
```

Stop the container frontend first if port 3000 is occupied. Vite proxies to localhost:8001; API_URL overrides that target. For a local production rebuild:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build -d --wait
```

## State ownership

- Server: accounts, paginated results, summary series, saved settings. Search/sort/filter/page execute on the API rather than downloading 10,500 accounts.
- URL: search, filters, signup dates, sort, page/size, and open account ID. Back/forward restores navigation. Search debounces 300ms and replaces history; explicit changes push history.
- Client: selected IDs across pages/filters, chart metric, pending inputs, request state and successful data. Full reload clears row selection.
- Settings: immutable snapshots separate current text, confirmed values, errors, and retry payloads. Pending edits/recovery use per-account sessionStorage; confirmed drafts restore from the API. Browser storage is best effort and session-local.

Table/chart fetch independently and poll every 15 seconds while visible. Query changes/unmount abort requests and ignore late responses. Dashboard timeout is 12 seconds; settings timeout is 15. Failed refresh retains successful data for that exact query with inline retry; changed queries never display old results as matching data.

Same-query polling updates values by ID and retains visible row positions, appending newly returned IDs. This favors focus/reading stability over resorting drifting numbers every poll. Explicit query/sort changes apply server order afresh. Select-page changes only that page's IDs.

## Settings and failure recovery

Click an account name (Edit account settings on mobile). Four steps cover contact, billing, optional limits, and optional webhook/review. Valid current-step edits autosave after 650ms. Navigation saves the departing step. Explicit Save is available. Final submission saves dirty/missing steps in order. Serialized writes and edit versions prevent old responses overwriting newer typing.

Validation rejection preserves input and shows server errors on the correct step. Network/server failure restores only the failed step's last confirmed values, keeping the attempted payload for explicit retry. Newer edits made during a failed request remain visible. Other steps are preserved. Closing backs up pending edits for the browser session. Failed final submission can be retried; a missing-step response invalidates those confirmations so retry actually saves them again.

The mock deliberately rejects billing saves once step 4 exists. The UI shows this on step 2 and offers Restore saved billing details. Final submission skips unchanged confirmed steps, avoiding the rejection loop. Step 4 cannot save before billing exists. An externally created step-4 draft with no billing cannot be repaired through this API, which provides no reset/delete endpoint.

## Dates, accessibility, and cuts

Date filters follow signup-date semantics and update table/chart. Other table filters do not affect summary, whose endpoint accepts only dates; the UI explains this. Invalid/inverted URL dates normalize. Charts offer minutes/SMS/cost and an accessible daily-values table. Display assumes cents represent USD.

Native controls have labels, focus styles, field error associations and sortable header state. Native dialog contains focus and supports Escape; headings receive focus on step changes. Mobile uses cards and a single-column form. The SVG/CSS loader supports reduced motion and never replaces existing content during polling.

Cuts: no marketing landing page, bulk edit/export, custom date picker, or virtualization. Server pagination bounds rows. The mock stores drafts in memory, so restarting it resets them. This local assessment console uses the supplied mock independently of Task 1.

## Checks

```sh
npm test
npm run build
```

20 tests cover queries/dates/decoding, cross-page selection, stable polling, validation, save races, per-step rollback, drafts, missing server steps, submission retry, and the deliberate billing rejection. See [verification](VERIFICATION.md) for observed results and limits.
