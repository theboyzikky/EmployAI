# Platform P0: the reusable foundation for real AI employees

P0 adds the channel-independent foundation from the approved four-layer architecture. Telegram (P1) will be the first *communication* connector on top of it; P0 itself names no channel.

## What P0 adds, by layer

| Layer | Module | What it does |
|---|---|---|
| **B. Integration** | `src/lib/integrations/types.ts`, `registry.ts` | A connector is a reusable adapter (`communication`, `business_system` or `developer`). Each one declares whether it is `real` or `simulated`. Each action declares its side effect (`read`, `write` or `external_message`; **money isn't available to connectors**) and its idempotency support. |
| | `connections.ts`, `credentials.ts` | A business's connection to a connector. **Grants** say which employee may use which actions; **routes** say which employee receives which event types. An employee can hold grants on any number of connections. Secrets are encrypted with AES-256-GCM, using a key derived per business from `APP_ENCRYPTION_KEY`, with the business and connection IDs bound in as additional authenticated data. They're never returned to the browser. |
| | `inbox.ts`, `api/hooks/[connectionId]` | External events come in: the routing index finds the business (and is re-checked), the connector verifies the request, each event is stored **once** per (connection, provider event ID) and marked **untrusted**, then routed to an employee (or flagged for the owner). |
| | `actions.ts` | Outbound actions are durable records, written before delivery, and authorisation is re-checked at send time (see "Delivery semantics" below). |
| | `providers/webhook.ts` | **Real** connector: generic signed webhooks (HMAC, 5-minute tolerance) in and out, with an `Idempotency-Key` header and protection against requests to internal addresses (SSRF). It works with any POS, inventory system, supplier platform or custom system that speaks HTTPS. |
| **C. Automation** | `src/lib/automation/tasks.ts`, `worker.ts`, `handlers.ts`, `run-handlers.ts` | Durable tasks live in each business's shared document and are enqueued **in the same commit** as the work they belong to. A worker claims a task with a lease, runs the handler for its kind (`drive_action`, `process_event`, `advance_run`), then settles it as done, later, retry with back-off, or dead (audited for the owner). |
| | `dispatch.ts`, `qstash.ts`, `api/worker`, `vercel.json` | Three independent ways to wake a worker (see "Recovery"). |
| **D. Oversight** | (existing) `security/gate.ts`, `authorisation.ts`, kill switch; (new) `authorise()` in `actions.ts` | Every action re-checks the kill switch, the employee's status, the connection's status and the grant at send time. Everything is audited in `activity_events`. |
| **A. Workforce** | (existing) catalogue, team approval, pause | P0 adds the connection model (grants and routes) that employees will use. Employee automations arrive in P1. |

**Background runs.** Starting a run, deciding an approval, resuming and retrying a payment now enqueue `advance_run` in the same commit. The worker drives the **same** `advanceRun()` the browser used, with the same leases, business lock, gate, owner approvals and fenced NEAR signer. The demo payment is still 0.031 NEAR, and the testnet controls are unchanged.

## Delivery semantics

EmployAI does **not** promise exactly-once delivery to external systems. It promises:

- **One record per logical action.** There's one durable record for each action (a unique idempotency key per business).
- **Write-ahead deliveries.** Each delivery is recorded before it's made, in the same commit that re-checks authorisation. Only one driver works on an action at a time (a lease).
- **Classified outcomes:**
  - `done`: with the provider's reference as proof;
  - `rejected`: provably not done; "try later" responses wait, with back-off;
  - `unknown`.
- **Unknown outcomes are never blindly retried.** They're reconciled if the connector can check with the provider, re-sent with the **same** key only when the provider honours it (at most 3 deliveries), and otherwise **escalated** to the owner.
- **Interrupted deliveries** are treated as `unknown`.
- **Payments are excluded.** They keep their own stricter path: write-ahead, contract-side replay protection, and reconciliation from the contract's request record.

## Recovery (all covered by tests)

| Failure | What happens | Test |
|---|---|---|
| **QStash unreachable** | `wake()` reports `QSTASH_UNREACHABLE` and nothing is thrown. The task stays queued in Redis. `after()` (in the request) and the recovery sweep still run it. | `automation.test.ts` "QStash unreachable…" |
| **QStash quota exhausted** (429) | Same as unreachable (`QSTASH_RATE_OR_QUOTA_LIMIT`). Retries count against the free quota, so wake-ups are deduplicated per minute. | same |
| **QStash not configured** (local) | `inline: false`, `NO_PUBLIC_URL` / `QSTASH_NOT_CONFIGURED`; the sweep processes the work. | same, plus `p0-acceptance.test.ts` "with QStash unavailable…" |
| **Redis unreachable** | Webhooks return 503 (the provider retries); the worker stops at once and `/api/worker` returns 503 (QStash retries); nothing runs or changes, so nothing is lost. | `inbox.test.ts`, `automation.test.ts` (shared mode) |
| **Worker crash mid-task** | The task's lease (90 s) expires and the next wake-up reclaims it. An action interrupted mid-delivery becomes `unknown`, so it's never re-sent blindly. | `automation.test.ts` "a worker that dies…", `actions.test.ts` |
| **Several workers at once** | Leases and compare-and-set mean one worker per task and one delivery per action. | `automation.test.ts`, `actions.test.ts`, `p0-acceptance.test.ts` |

**Wake-up paths:**
1. `after()`, right after the request that created the work.
2. A QStash-signed POST to `/api/worker` (a backstop 30 s later, and for delayed retries).
3. The **recovery sweep**, which walks the `work:due` index. It's piggy-backed on every inbound webhook, and also run by `/api/worker` with no body and by the daily Vercel cron (`GET /api/worker`, `CRON_SECRET`). A QStash schedule every 5 minutes can call it too: 288 messages a day, inside the free 1,000.

**Operator runbook:**
- **Stop real payments:** `SET eai:ops:testnet_paused 1`.
- **Stop live AI:** `SET eai:ops:ai_paused 1`.
- **Drain the backlog after an outage:** `curl -X POST https://<site>/api/worker -H "Authorization: Bearer $EMPLOYAI_WORKER_SECRET" -H "content-type: application/json" -d '{}'` runs a sweep.

## Real vs simulated

- **Real:** the generic signed-webhook connector (inbound and outbound HTTP), the NEAR testnet payment path, and NEAR AI.
- **Simulated:** the run tools that were already simulated (`send_order_confirmation`, `request_quote`, `notify_owner`) are still simulated and labelled.
- **Not yet in P0:**
  - employee automations for inbound events (they're kept and flagged for the owner, never invented);
  - a Connections screen (the API exists);
  - Telegram.

## Manual setup (when deploying)

| Variable | Purpose |
|---|---|
| `APP_ENCRYPTION_KEY` | 32+ random characters. Required to store connection secrets. Changing it makes stored secrets unreadable, so connections would need reconnecting. |
| `EMPLOYAI_PUBLIC_URL` | The site's https origin (QStash needs it to call `/api/worker`). Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used if this isn't set. |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` if Upstash shows a regional URL) | From the QStash tab of your Upstash account. Optional: without them, the inline and sweep paths still work. |
| `EMPLOYAI_WORKER_SECRET` | 32+ characters. Lets an operator call `/api/worker`. |
| `CRON_SECRET` | 16+ characters. Vercel sends it to the daily cron. |
