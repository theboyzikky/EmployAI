# 04 · API design (simplified)

Status: **Revised 2026-11-05 to match [00-mvp-scope.md](00-mvp-scope.md). Awaiting approval.**

## Conventions

- Next.js route handlers under `/api`. JSON in and out, every body parsed with zod, unknown fields rejected.
- **Authentication:** a Supabase session cookie (`@supabase/ssr`). A visitor who types in the hero gets an **anonymous** Supabase session automatically, which they can upgrade to email later without losing the workspace.
- **Authorisation:** every `/api/w/:businessId/*` route checks `businesses.owner_id = session user`, and RLS enforces the same thing. Another user's workspace returns `404`.
- **Idempotency:** `POST /api/w/:id/runs` takes an `Idempotency-Key`. A repeat returns the same run.
- **Long work** returns `202 { id }`, and the client polls the matching `GET`.
- **Error envelope:** `{ "error": { "code", "message", "details"?, "correlation_id" } }`.

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `WORKFLOW_INVALID` |
| 401 / 404 | `UNAUTHENTICATED` / `NOT_FOUND` (also used for other owners' resources) |
| 409 | `STATE_CONFLICT` (for example deploying before the team is approved, or deciding an expired approval) |
| 422 | `SECURITY_BLOCKED`, `BUDGET_EXHAUSTED`, `KILL_SWITCH_ACTIVE` (the body includes reason codes) |
| 429 | `RATE_LIMITED` (in-memory per-IP limit on anonymous session creation and the public ledger) |
| 502 | `AI_UNAVAILABLE`, `CHAIN_UNAVAILABLE` (safe to retry) |

## Endpoints (18 planned; M2 added `discovery/analyse`, `PATCH discovery` and `team/approve`)

### Discovery (steps 1–2)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/start` | `{ message?: string ≤ 4000 }` | `201 { business_id }`. Creates an anonymous session if needed, then the business (`discovering`), with the message stored verbatim. |
| `GET /api/w/:id/discovery` | — | `{ view }`: messages, fields (value, status, sources), analysis, stage, team, AI mode |
| `POST /api/w/:id/discovery/messages` | `{ content?, client_message_id?, skip? }` | `200 { view }` with the consultant's reply **in the same request** (decision D5, 2026-11-05). The owner's message is saved first; on an AI failure `502 AI_UNAVAILABLE` returns the current view (nothing lost) and `{}` retries the reply. A repeated `client_message_id` is stored once. |
| `POST /api/w/:id/discovery/analyse` | `{}` | `200 { view }` (added in M2): grounded analysis; `409` until the application decides there is enough information |
| `PATCH /api/w/:id/discovery` | `{ fields }` | `200 { view }` (added in M2): owner corrections; they lock the field and mark the analysis stale. Editing a confirmed summary withdraws the proposal; `409` after the team is approved. |
| `POST /api/w/:id/discovery/confirm` | `{ fields? }` | `200 { view }`; `409` if the analysis is stale |

### Team (steps 3–4)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/w/:id/team/propose` | — | `202`. Fails `409` if the profile isn't confirmed. |
| `GET /api/w/:id/team` | — | `{ agents[] (definition, capability, executable, status) }` |
| `PATCH /api/w/:id/team/:agentKey` | `{ status?: 'proposed'\|'removed', tasks?: {id: bool}, owner_note? }` | `200 { view }`. Tools, scopes and money permissions are **not** editable: they come from the catalogue. |
| `POST /api/w/:id/team/approve` | `{}` | `200 { view }` (added in M2). Records approval of every kept agent with a timestamp. **Deploys and runs nothing.** |

### Workflows and runs (steps 5–6)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/w/:id/workflows/generate` | — | `202`. Uses the approved, executable agents. |
| `GET /api/w/:id/workflows` | — | `{ workflows[] (steps, validation, status) }` |
| `POST /api/w/:id/workflows/:wid/deploy` | — | `200`. Fails `409` if invalid. |
| `POST /api/w/:id/runs` | `{ workflow_id, scenario: 'standard'\|'new_supplier'\|'attack' }` + `Idempotency-Key` | `202 { run_id }` |
| `GET /api/runs/:runId` | — | `{ run (status, elapsed_ms), steps[] (agent, task, output, reasoning, status), decisions[], ledger[] }` (owner only) |

### Security (step 7)

| Method & path | Request | Response |
|---|---|---|
| `GET /api/w/:id/security` | — | `{ policy, policy_version, kill_switch, decisions[], approvals[] }` |
| `POST /api/w/:id/approvals/:approvalId` | `{ decision: 'approve'\|'reject' }` | `200`, and the run resumes. Fails `409` if expired or invalidated. |
| `POST /api/w/:id/kill-switch` | `{ active: boolean }` | `200 { active }`. Effect is immediate in-app: new runs refused, pending approvals invalidated, signing refused. The response includes `onchain_paused` read from the contract, and the owner command to pause or unpause on-chain. |
| `POST /api/security/evaluate` | `ActionRequest` | `200 Decision`. Used by the attack script and tests. The runner calls the same function in-process. |
| `POST /api/blocklist` | `{ account_id, reason, evidence: { type: 'tx'\|'url'\|'text', ref } }` | `201 { status: 'reported' }`. The server computes `evidence_sha256`. |

### Ledger (step 8)

| Method & path | Request | Response |
|---|---|---|
| `GET /api/ledger/:slug` (**public**) | — | `{ business_name, demo: true, entries[] (type, mode, amount, unit, counterparty, agent, tx_hash?, explorer_url?, occurred_at) }` |

## Core shapes

```ts
// ActionRequest — canonical JSON is hashed into action_hash
{ business_id, run_id?, agent_key, tool: 'request_payment',
  contract_id: string, method: 'request_payment',
  recipient: string, amount_yocto: string, purpose: string,
  provenance: { trusted: boolean, sources: ('system'|'owner'|'agent'|'supplier'|'customer')[] },
  request_id: string }   // also sent to the contract for on-chain dedupe

// Decision
{ decision_id, decision: 'ALLOW'|'WARN'|'BLOCK', reason_codes: string[],
  explanation: string,   // template text (an LLM paraphrase is display-only)
  signals: { exists, is_contract, code_hash, code_changed, age_days|null, tx_count|null,
             prior_payments, blocklist: 'none'|'reported'|'confirmed', fetched_at },
  policy_version, approval_id?, expires_at }
```

The browser never receives private keys, the NEAR AI key, the service-role key, or other users' data.
