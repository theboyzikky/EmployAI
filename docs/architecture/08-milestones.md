# 08 · Development milestones (simplified scope)

Status: **Revised 2026-11-05.** Deadline: **2026-11-14 23:59 UTC** (Nov 15 00:59 Lagos). The plan follows the 8-step journey in [00-mvp-scope.md](00-mvp-scope.md), so every milestone ends with something you can click through. M7 is reserved entirely for **polish**.

Each milestone ends with tests run (commands and results reported), changed files listed, the README "do X, see Y" steps updated, a secret scan, and a local commit after your OK. Nothing is pushed without your say-so.

**Zero-additional-spending directive ([09](09-zero-spend-plan.md)):** every milestone is built and tested with the `mock` AI provider, local tests, free testnet and free tiers. No milestone depends on paid inference or paid hosting.

| Milestone | Dates | Journey steps | Deliverables | Done when |
|---|---|---|---|---|
| **Gate 1 approval** | Nov 5 | — | This revised document set and the security signal sources (this also covers the old Gate 3). Tracks are already decided: `business` + `security`. | You approve |
| **M0 · Spikes (all free)** | Nov 5–6 | — | PoC-A0 (AI provider contract, offline), PoC-B (testnet accounts, function-call key, treasury spike on Windows; **needs your approval**), PoC-C (database). PoC-A (real NEAR AI) is **deferred**. | All pass, or blockers reported with options |
| **M1 · Foundation and landing page** | Nov 6 | 1 | Next.js app; design tokens, Manrope, shadcn base; **landing page** (all PRD §17.4 sections, working hero input, suggested prompts, motion with reduced-motion support); migrations 0001–0004 + seed; anonymous session; workspace shell with 5 tabs | AT-01 (hero text persists), AT-02 (page usable without typing), AT-15 (mobile); `next build` passes |
| **M2 · Discovery consultant + AI team proposal** (scope extended by the owner, 2026-11-05) | Nov 7–8 | 1–4 | Five-stage consultant (introduce → discover → analyse → confirm summary → review team); "What I understand" panel with confirmed / unconfirmed / unknown fields; grounded business analysis (every insight cites the owner's messages or answers); editable summary and confirmation; **capability catalogue, deterministic team proposal, agent cards, configure / remove / approve** (moved from M3); AI provider layer with `mock` (offline rules) and the `nearai` adapter (built, not used: no live calls); "AI mode" badge; local development store shaped like the approved tables. **Nothing is generated, deployed or executed.** | AT-01, AT-03, AT-04, AT-05: a restaurant gets Orchestrator + Order, Inventory, Procurement, Finance; a salon gets a smaller team with honest "Preview" labels. Done — see the [M2 report](poc-results/m2-report.md). |
| **M3 · Workflow generation and approval** (was "AI team"; the team proposal moved into M2) | Nov 8 | 5 | Workflow schema (8 step types), restaurant template, deterministic generation (no AI), path-based validator, read-only diagram + list, owner settings (illustrative NGN), **approve workflow** (versioned; approving runs nothing); Team and Workflows tabs; restaurant is the only runnable scenario (others Preview); labelled demo data. Local development store (M2 D2) until Supabase is approved. | AT-06: an invalid workflow can't be approved. Built, awaiting review: see the [M3 report](poc-results/m3-report.md). |
| **M4 · Test runs and collaboration** | Nov 9 | 6 | In-process runner for the approved workflow ("Run demo order"); the four agents; **live collaboration timeline**; payment step in `test_run` mode until M5 | AT-06; a demo order runs end to end off-chain with every handoff visible; "Test run — no transaction" labels |
| **M5 · Security and NEAR testnet (Gate 4 vertical slice)** | Nov 10–11 | 7–8 | Treasury contract + unit tests; `scripts/provision-testnet` (you run it); `config.yaml` → policy → on-chain `set_policy`; security gate (rules + signals), approvals, kill switch; signer wrapper; customer `pay_order` + agent `request_payment`; ledger + public page; elapsed timer | **The full journey works on testnet.** AT-08 (ALLOW, paid), AT-09 (WARN, approved, paid), AT-11 (kill switch), AT-13 (key revoked); explorer links; **measured sale-to-payout under 2 min** (B8) |
| **M6 · Security track evidence (Gate 5)** | Nov 12 | 7 | Blocklist report UI and API with evidence; `npm run demo:attack` (**Part B, the scripted compromised agent, is always run**; Part A, live LLM, runs only if inference is approved, otherwise it's logged as "not run"); README key-limits section; tests (gate rules, signer refusal, two-user isolation, idempotency) | AT-10; the attack log shows BLOCK and no transaction; every track claim matches evidence |
| **M7 · Polish, README, video** | Nov 13 | all | **Polish pass:** copy, empty and loading states, error states, motion timing, accessibility (labels, focus, contrast), mobile layouts. **Local run documented step by step** (a hosted demo only on an approved free tier, D-10). Final README judge steps with **measured** results. Screenshots. Demo-video script (you record it). | Fresh clone plus README works (AT-14 credential-free paths); Playwright happy path green on desktop and mobile |
| **M8 · Submission (Gate 6)** | Nov 14 | — | Feature freeze, history secret scan, repo public (you, or me on your explicit OK), X post (you), submission payload printed for your confirmation | You confirm and it's sent once, before 23:59 UTC |

## Submission plan (Gate 6)

**Tracks submitted:** `["business", "security"]`. `business` is the primary product direction, and `security` is the secondary track. `swarms` is **not selected** (owner decision, 2026-11-05). A track is dropped from the form if its Gate 5 evidence isn't complete (PRD §6.1).

| Item | Evidence a judge sees | Owner | When |
|---|---|---|---|
| Public repository | Source, `contracts/treasury`, migrations, tests, `docs/architecture/`, README, LICENSE, `config.yaml` | Me (you make it public, or I do on your explicit OK) | M8 |
| README for an AI judge | What it is · the problem · numbered **"do X, see Y"** steps (local run in offline-AI mode with no paid keys, run demo order, see the testnet transactions on the ledger, run `npm run demo:attack`, run the contract unit tests) · what's testnet vs off-chain · **function-call key limits** · **AI mode used** (offline demo AI unless real inference was approved) · known limitations (no Intents on testnet, owner-funded inference, prototype scope) · libraries and baseline (Q-005) | Me | M7 |
| `business` evidence | Live run timeline with all five agents; ledger with sale, revenue-share and supplier-payout explorer links; `config.yaml` policy; **measured** sale-to-payout time; kill switch | Me (build), you (video) | M5, M7 |
| `security` evidence | Decision log with ALLOW / WARN / BLOCK and reasons; signal panel (age, activity, contract/code hash, prior payments, blocklist); the blocklist report with evidence; attack-demo log ("no transaction hash"); key-limits section | Me | M6 |
| Demo video (required: Q-012 says screenshots aren't enough if judges can't open the demo) | 2–3 min: describe the restaurant → questions → team → approve → workflow → run → security decisions → testnet ledger → attack blocked | You record; I write the script | M7 |
| Hosted demo (D-10) | **Optional.** Only on a free tier you approve that needs no payment, kept up until at least 2026-11-18. Otherwise the local run + video, which Q-012 accepts. | You decide | M7 |
| X post | Says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, video attached | You publish; I draft | M8 |
| Mainnet payout account | A named or implicit mainnet account you create (never invented by me) | You | M8 |
| Final checks | History secret scan, every track claim matched against evidence, live HACKATHON.md re-read for rule changes | Me | M8 |
| Submission | Form or API payload with `projectName`, `leadName`, `email`, `size`, `tracks: ["business","security"]`, `nearAddress`, `projectUrl`, `demoUrl`, `idea`, `consent`. **Printed in full for your confirmation**, sent once with a single `requestId`, before 2026-11-14 23:59 UTC. Not committed (contains personal data). | You confirm; I send only after your explicit yes | M8 |

## Critical path

```text
Gate 1 ─► M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8
            └── PoC-B (testnet + contract) de-risks M5, the hardest milestone
```

- The **treasury contract** (`contracts/`) only touches its own files, so it could start right after PoC-B, in parallel with M1–M4, if you want a second session for it.
- **Cut order if behind** (P0 is never cut silently; a P0 shortfall removes that track from the submission):
  1. on-chain pause from the UI (owner script stays)
  2. second business-type polish
  3. hosted demo (keep local + video, Q-012)
  4. blocklist report UI (keep the API + seeded fixture)
