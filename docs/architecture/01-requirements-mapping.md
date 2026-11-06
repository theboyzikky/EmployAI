# 01 · Track requirements mapping (simplified scope)

Status: **Revised 2026-11-05 to match [00-mvp-scope.md](00-mvp-scope.md). Awaiting approval.**

Sources, re-read live on 2026-11-04: `tracks/04-business.md`, `tracks/05-swarms.md`, `tracks/06-security.md`, `00-setup.md`, `SUBMITTING.md` (upstream commit `7873343`), and HACKATHON.md. The prompt text in `docs/PRD.md` Appendices A–D is identical to upstream.

Per the upstream README, the bracketed starter ideas are replaced with EmployAI, and **every requirement and checkpoint of a track we pursue is kept**. Columns:

- **Type:** *Mandatory* (in the prompt's requirements, rules or checkpoint), *Narrative* (in the scenario sentence only), *Optional* (hints, Q-011).
- **Journey step:** where it shows up in the 8-step demo (00-mvp-scope).

## 1. Autonomous Business (`business`): primary track, formally targeted

| # | Requirement | Type | Step | EmployAI implementation | Module | Acceptance test | Evidence |
|---|---|---|---|---|---|---|---|
| B1 | "Give the agent its own NEAR account." | Mandatory | 8 | The Finance Agent owns `finance-agent.employai-demo.testnet`, registered in the treasury contract as an authorised agent | `contracts/treasury`, `lib/near` | Every payout event names this account as the agent | Explorer link to the account and payout |
| B2 | "Never store a full-access key in plain text; use OutLayer agent custody or a scoped function-call key." | Mandatory | 7–8 | A **function-call key**: receiver `treasury`, methods `["request_payment"]`, allowance unset. Only this key is in the server env. The account's full-access key stays with the owner's NEAR CLI keychain. | `lib/near/signer` | Transfer, `set_policy` and other-contract calls signed with the key all fail; after the owner deletes the key, calls fail (AT-13) | README "Key limits" plus CLI output |
| B3 | config.yaml: "maximum inference spend per day" | Mandatory | 2–6 | `policy.max_inference_usd_per_day`; the budget guard checks before every AI call for any provider; cost recorded per call (billing API, or estimate labelled as such). **Zero-spend default:** with offline demo AI, costs are $0 (stated on the ledger), and cap enforcement is proven with fixture costs in unit tests. Real-cost enforcement needs approved NEAR AI calls (09). | `lib/ai/budget` | At the cap, no further call; event logged; run pauses (AT-16) | Ledger `inference_cost` rows |
| B4 | config.yaml: "minimum price per report" → **minimum order value** | Mandatory (adapted) | 6, 8 | Checked by the Order Agent **and** by `pay_order` on-chain | `lib/agents/order`, `contracts/treasury` | A below-minimum order is rejected off-chain, and a below-minimum deposit panics on-chain | Activity row plus a failed tx |
| B5 | config.yaml: "revenue split percentages" | Mandatory | 8 | Split basis points in contract state (sum must be 10 000). `pay_order` transfers the contributors' share in the same transaction | `contracts/treasury` | Contributor amount = sale × bps / 10 000; a split that doesn't sum to 100 % is rejected | Ledger `revenue_share` row with hash |
| B6 | config.yaml: "a kill switch I can flip at any time" | Mandatory | 7 | **In-app switch** (instant: refuses new runs, invalidates pending approvals, signer refuses) **plus on-chain `pause`** owner script. Guardian key for on-chain pause from the UI is P1. | `lib/security`, `contracts/treasury` | AT-11 | Security screen plus pause tx |
| B7 | "Log every sale, cost and payout to a public ledger page." | Mandatory | 8 | Public `/ledger/[slug]`: sales, revenue share, supplier payouts (testnet, with explorer links) and inference costs (off-chain) | `lib/ledger` | FR-16: all types present, correctly labelled, no fabricated hashes | Ledger screenshot |
| B8 | "A demo mode that runs one full loop on testnet, from sale to payout, in under two minutes." | Mandatory | 6–8 | "Run demo order": customer `pay_order` → agents → gate → `request_payment` payout. `elapsed_ms` measured and shown | `lib/workflows/runner` | Three consecutive runs under 120 s; README reports the **measured** time | Timer in the UI plus video |
| B9 | Checkpoint: read the AI, NEAR and OutLayer docs, sketch the architecture, wait for OK | Mandatory | — | Gate 1 (these docs) | `docs/architecture` | Owner approval | — |
| B10 | "Customers pay in whatever token they hold through NEAR Intents" | Narrative | — | **Not attempted.** Intents has no testnet (HACKATHON.md Q-007; OutLayer docs). The customer pays native testnet NEAR. The README says so. | — | — | README statement |
| B11 | "the agent buys its own inference from NEAR AI Cloud" | Narrative | — | Can't be done autonomously on testnet (staking credits are mainnet and linked through a user session). Implemented as **metered, owner-funded inference with a per-business daily cap and per-agent cost tracking**, labelled exactly that way. | `lib/ai` | AT-16 | README statement |
| B12 | "a fixed share of every sale goes to a contributors' account automatically" | Narrative → **implemented** | 8 | = B5 | — | — | — |
| B13 | Track theme: "AI-native businesses that run their own treasury, sales, procurement … Humans only set the constraints." | Theme → **implemented** | 3–6 | Internal workforce: **Business Orchestrator + Order, Inventory, Procurement and Finance Agents** collaborate on each demo order through typed handoffs. The owner sets the constraints in `config.yaml` and approves the team. | `lib/agents`, `lib/workflows/runner` | FR-12: every handoff logged with requester, assignee, task, status and result | Live run timeline plus video |

## 2. AI Security & Defense (`security`): secondary track, formally targeted

| # | Requirement | Type | Step | EmployAI implementation | Module | Acceptance test | Evidence |
|---|---|---|---|---|---|---|---|
| X1 | "Before an agent sends funds or calls a contract, it asks this service about the receiver … returns allow, warn or block, plus the reasons." | Mandatory | 7 | `evaluate()` (in-process) and `POST /api/security/evaluate`, with reason codes, signal snapshot and policy version. It checks both the contract being called and the payment recipient. | `lib/security` | AT-08, AT-09, AT-10 | Security screen decision log |
| X2a | Signal: account age and activity history | Mandatory | 7 | NearBlocks testnet `/v1/account/{id}` → `created.block_timestamp`; `/txns/count` (verified live 2026-11-04). Unknown → WARN, never guessed. | `lib/security/signals` | Fixture tests plus a live smoke test | Signal panel |
| X2b | Signal: is it a contract, did its code change recently | Mandatory | 7 | RPC `view_account.code_hash` (verified). The last seen hash is kept in the previous decisions' `signals`; a change → WARN; a first-seen contract → WARN. | `lib/security/signals` | Fixture test | Signal panel |
| X2c | Signal: prior interactions between this agent and the receiver | Mandatory | 7 | Past `supplier_payout` ledger rows from this agent to this recipient; none → `FIRST_INTERACTION` (WARN) | `lib/security/signals` | Fixture test | Signal panel |
| X2d | Signal: shared blocklist other agents can report to, with evidence | Mandatory | 7 | `blocklist_reports` (shared across all workspaces) plus `POST /api/blocklist` with required evidence and a server-computed SHA-256. Confirmed → BLOCK; reported → WARN. | `lib/security` | Confirmed blocks, reported warns | Security screen blocklist |
| X3 | "An agent-side wrapper that refuses to sign when the answer is block and asks a human when it's warn." | Mandatory | 7 | The signer wrapper signs only after atomically consuming an `approved` authorisation whose `action_hash` matches. BLOCK leaves no authorisation; WARN leaves a pending one for the owner. | `lib/near/signer` | Calling the signer without an authorisation throws (unit test) | Attack log "no signature" |
| X4 | "The agent signs with a function-call access key scoped to one contract, never a full-access key. Explain the limits of that key in the README." | Mandatory | 8 | = B2. A README section covers what the key can and can't do, allowance, revocation and recovery. | `README.md` | = B2 | README |
| X5 | "An attack demo: a script where a prompt-injected agent tries to pay a known-bad address and gets stopped. Show the log." | Mandatory | 7 | `npm run demo:attack`. A supplier quote carries an injection. **Part B (always, free):** a scripted, fully compromised agent makes the injected payment request and is blocked, which shows enforcement doesn't depend on the model. This alone meets the requirement. **Part A (only if inference is approved):** the live Procurement LLM; if it takes the bait, the gate blocks. Needs no NEAR keys and no AI credits. The same scenario can be run in the UI (`scenario: 'attack'`). | `scripts/demo-attack` | AT-10, FR-19 | Log in the README plus video |
| X6 | Checkpoint: list the data source for each signal, wait for OK | Mandatory | — | [05 §4](05-threat-model.md#4-risk-signal-data-sources) | — | Owner approval | — |
| X7 | Note: function-call-only accounts can't transfer or add keys, and can lock themselves out when the allowance runs out | Mandatory to address | — | Allowance unset; the owner keeps a full-access recovery key; documented | `README.md` | Reviewed | README |
| X8 | Hints: TEE attestation, OutLayer | Optional | — | Not used, and no TEE claims | — | — | — |

## 3. AI Swarms (`swarms`): **removed as a target** (owner decision, 2026-11-05)

Not implemented and not selected in the submission. Nothing from its mandatory list is built:
- 25 agents with their own on-chain sub-accounts
- a sealed-bid coordinator
- RULES.md and a round diagram
- the 20-buyer / 5-seller simulation
- a live market page

EmployAI's internal collaboration between the Orchestrator and four specialist agents (B13) stays, and is never presented as a swarm.

## 4. Hackathon-wide requirements

| # | Requirement | How it is met |
|---|---|---|
| H1 | Public repo by 2026-11-14 23:59 UTC; README with "do X, see Y" steps, no marketing | README maintained per milestone |
| H2 | X demo post with a video (Q-012: a video is required if judges can't open the demo) | Owner posts; I draft the text |
| H3 | Mainnet payout account (owner creates it) | Owner |
| H4 | Select every fitting track | `tracks: ["business", "security"]`, each only if its evidence exists at Gate 5 (PRD §6.1) |
| H5 | No secrets in history | Secret scan before every commit |
| H6 | LICENSE | ✅ MIT |
| H7 | Libraries and baseline listed (Q-005) | README |
| H8 | Submission payload confirmed before sending | Gate 6 |
