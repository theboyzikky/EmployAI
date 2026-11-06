# 00 · Simplified MVP scope (authoritative)

Status: **Revised 2026-11-05 at the owner's request. Track decision final (2026-11-05). Zero-additional-spending directive in force ([09-zero-spend-plan.md](09-zero-spend-plan.md)): development and tests use the offline provider at zero cost; **NEAR AI Cloud is mandatory for the real AI functionality and the final live demo**, with each spending batch approved first. The rest of the architecture still awaits approval.** This document sets the scope. Documents 01–08 have been revised to match it. If anything conflicts, this document wins.

EmployAI is a **hackathon prototype** that introduces and demonstrates one idea: *describe your business, and EmployAI designs, builds and safely runs an AI workforce for it.* The goal is a **small, polished, genuinely working** end-to-end experience, not a commercial platform.

## The demo journey (what must work, end to end)

| # | Step | What the user sees | What is real |
|---|---|---|---|
| 1 | **Describe the business** | Landing-page hero chat; the message continues into the consultant page | Saved conversation |
| 2 | **Discovery questions** | A consultant asks 3–6 focused follow-ups; the "What I understand" panel fills in; a summary to confirm | **Final demo: NEAR AI Cloud** (Qwen 3.8 27B, strict JSON extraction; PoC-A 5/5). Development and tests: a rule-based offline consultant (labelled "Offline demo AI"). |
| 3 | **Recommended AI team** | Orchestrator + specialist agents, each with purpose, responsibilities, tools, limits and "never does" | Deterministic mapping from the profile to a fixed **capability catalogue**; an LLM refines the wording when enabled |
| 4 | **Review and approve** | Edit, remove or approve each agent; nothing runs before approval | Approval stored with a timestamp |
| 5 | **Generate and approve workflows** | A step-by-step workflow graph per scenario, validation ticks, "Approve workflow" | Template-based generation (deterministic); a path-based validator; the approved version is stored and locked. Approving runs nothing (test runs start in M4). |
| 6 | **Agents collaborate on a real scenario** | "Run demo order": a live timeline of Order → Inventory → Procurement → Finance handoffs, with reasoning | Real runs with every step persisted. Procurement: deterministic scoring decides the eligible options, and **Haiku 5.5 via NEAR AI** writes the recommendation through a tool call (PoC-A 10/10). Offline mode uses a templated rationale. |
| 7 | **Security controls sensitive actions** | The supplier payment goes through the security check: ALLOW, WARN (owner approves) or BLOCK; kill switch | Deterministic gate, single-use decisions, approval queue |
| 8 | **Meaningful NEAR testnet transaction** | (a) the customer's order payment is split automatically to a contributors' account; (b) the Finance Agent pays the supplier through the treasury contract; both have explorer links on a public ledger | **Real testnet transactions** with a policy-enforcing contract and a restricted (function-call) agent key |

**Industry-agnostic by design.** Discovery, the capability catalogue and agent proposals work for any business type, so a salon, an online shop or a consultancy gets its own team. The **restaurant** is the seeded scenario whose workflow is fully executable. For other business types, proposed agents built from capabilities without a runnable scenario are shown as **"Preview — not executable in this prototype"**. That's an honest label, not a fake run.

## Track decision (final, owner, 2026-11-05)

| Track | Status | Mandatory requirements we must deliver |
|---|---|---|
| `business` | **Primary — formally targeted** | Agent's own NEAR account; function-call key (no full-access key in plain text); `config.yaml` rules (daily inference cap, minimum order, revenue split, kill switch); public ledger of every sale, cost and payout; testnet sale-to-payout loop under 2 minutes. |
| `security` | **Secondary — formally targeted** | Pre-signing counterparty check returning ALLOW/WARN/BLOCK with reasons; the 4 signals (account age/activity, contract/code change, prior interactions, shared blocklist with evidence); an agent-side wrapper that refuses on BLOCK and asks a human on WARN; a function-call key scoped to one contract, with its limits explained in the README; a prompt-injection **attack demo script** with a log. |
| `swarms` | **Removed as an implementation and submission target** | None. We don't build the 20-buyer/5-seller sealed-bid marketplace, swarm sub-accounts, coordinator, collective purchasing or market page, and `swarms` won't be selected in the submission form. |

### Internal multi-agent collaboration (kept, part of `business`)

The five agents of the restaurant workforce stay, and they collaborate on every demo order:

| Agent | Role in the demo order |
|---|---|
| **Business Orchestrator** | Runs the approved workflow, delegates each task, records every handoff (requester, assignee, task, result), and summarises the run |
| **Order Agent** | Validates the order against the menu and the minimum order value |
| **Inventory Agent** | Updates stock, detects items below the reorder threshold, sets the reorder quantity |
| **Procurement Agent** | Compares supplier quotes and recommends a supplier, with a rationale |
| **Finance Agent** | Checks budget and policy, then requests the supplier payment through the security gate. It's the only agent with a NEAR account and signing key. |

This is **internal agent coordination inside one business**. The README, UI and submission will never call it a "swarm", and we won't claim the swarm track (PRD §6, "Track integrity"; PRD §6.1 allows removing a track whose demonstration isn't built).

## In scope (P0)

- Landing page (PRD §17.4 sections, working hero input), consultant onboarding, and a workspace with **5 screens**: Overview, AI Team, Workflows (including the run timeline), Security (policy, decisions, approvals, kill switch, blocklist), Ledger (also public).
- **A configurable AI provider** with `AI_PROVIDER` set explicitly: `nearai` for the product and final demo (Qwen: discovery JSON; Haiku: tool calls), and `mock` for development and tests. Structured outputs validated with zod, a daily inference cap per business, cost recorded per call, no silent fallback.
- Capability catalogue and agent proposal; approval.
- Workflow schema with **8 step types** (`trigger`, `agent_task`, `condition`, `security_check`, `approval`, `payment`, `notify`, `end`), a validator, owner approval, and an in-process runner that persists every step.
- Restaurant scenario: order → stock check → reorder need → 3 supplier quotes (seeded, fictional) → Procurement recommendation → Finance payment request → security gate → testnet payout.
- Treasury contract (Rust): `pay_order` (sale + automatic split), `request_payment` (registered agent, approved recipient, per-transaction and daily caps, paused flag, request ID dedupe), owner `set_policy` / `pause` / `unpause`.
- Security gate, approval queue, kill switch (in-app immediately; on-chain pause by owner script), shared blocklist with evidence, the 4 signals, and the attack demo script.
- Public ledger: sales, inference costs, payouts. Every row labelled **testnet** or **off-chain**, with explorer links only for real hashes.
- README with "do X, see Y" steps and a demo video. Local run by default; a hosted demo only on a free tier you approve (D-10).

## Out of scope (removed from the earlier Gate 1 proposal)

| Removed | Replaced by |
|---|---|
| Separate worker process + pg-boss queue | An in-process runner in the Next.js Node server, with each step persisted. A run interrupted by a restart is shown as "interrupted" with a resume button. |
| npm-workspace monorepo with 10 packages | One Next.js app with `src/lib/*` modules, plus `contracts/treasury` |
| Swarm market contract, 25 swarm sub-accounts, sealed-bid coordinator, collective purchasing, swarm pages | Not built. `swarms` is removed as a target (owner decision, 2026-11-05). Procurement compares 3 seeded supplier quotes inside the workflow. |
| Generic webhooks, HTTP connector, integration and secret tables | Demo order button and form only |
| Per-agent NEAR AI API keys, encrypted key table, `APP_ENCRYPTION_KEY` | One NEAR AI key with a dashboard spend limit, plus in-app per-agent budget tracking. The **one** agent signing key (function-call only) lives in a server env var. |
| Owner wallet connect, OutLayer custody, NEAR Intents, Agent API, PingPay | Owner actions via NEAR CLI scripts. Intents is mainnet-only (Q-007) and isn't attempted. The README states this plainly. |
| Free-form DAG editor and canvas library | Template-based generation, plus a simple custom read-only graph and step list |
| 35 database tables | **11 tables** (see 03) |
| Multi-member roles | One owner per workspace (anonymous session that can be upgraded) |
| Guardian key for on-chain pause from the UI | P1: the in-app kill switch acts instantly; on-chain `pause` runs via an owner script |
| Notifications, policy YAML export UI, analytics | Not built (`config.yaml` is the policy file) |

## Success criteria (prototype "done")

1. A first-time visitor completes steps 1–5 for **a restaurant and for one other business type** without errors, on desktop and mobile.
2. "Run demo order" completes steps 6–8 on testnet, with the **sale-to-payout time measured and shown** (target under 2 minutes, reported as measured).
3. A payment to a non-approved recipient gets WARN, the owner approves it, and it's paid. The known-bad recipient gets BLOCK with no transaction. The kill switch stops new runs.
4. `npm run demo:attack` prints the injected instruction, the BLOCK decision, the reasons and "no transaction hash", with no keys and no AI credits needed (Part B; Part A only if inference is approved).
5. The ledger shows real explorer links for the on-chain rows, and nothing simulated is presented as on-chain.
6. A judge can follow the README: the video, a local run in offline-AI mode with no paid keys, and credential-free scripts (the attack demo and contract unit tests).
7. Development and testing need **zero additional spending** (offline mode). The **final live demo runs on NEAR AI Cloud** within a separately approved budget. AI mode is labelled on screen, and a NEAR AI failure shows "AI unavailable", never a silent switch to offline mode.
