# 08 · Development milestones (simplified scope)

Status: **Revised 2026-11-06: M3.5 · Discovery intelligence inserted between M3 and M4 (owner decision). M3.5 approved, revised (understanding first, AC-1 to AC-22) and implemented offline; awaiting owner review ([M3.5 report](poc-results/m3.5-report.md)).** Previous revision 2026-11-05. Deadline: **2026-11-14 23:59 UTC** (Nov 15 00:59 Lagos). The plan follows the 8-step journey in [00-mvp-scope.md](00-mvp-scope.md), so every milestone ends with something you can click through. M7 is reserved entirely for **polish**.

Each milestone ends with tests run (commands and results reported), changed files listed, the README "do X, see Y" steps updated, a secret scan, and a local commit after your OK. Nothing is pushed without your say-so.

**Zero-additional-spending directive ([09](09-zero-spend-plan.md)):** every milestone is built and tested with the `mock` AI provider, local tests, free testnet and free tiers. No milestone depends on paid inference or paid hosting.

| Milestone | Dates | Journey steps | Deliverables | Done when |
|---|---|---|---|---|
| **Gate 1 approval** | Nov 5 | — | This revised document set and the security signal sources (this also covers the old Gate 3). Tracks are already decided: `business` + `security`. | You approve |
| **M0 · Spikes (all free)** | Nov 5–6 | — | PoC-A0 (AI provider contract, offline), PoC-B (testnet accounts, function-call key, treasury spike on Windows; **needs your approval**), PoC-C (database). PoC-A (real NEAR AI) is **deferred**. | All pass, or blockers reported with options |
| **M1 · Product foundation** (foundation and landing page) | Nov 6 | 1 | Next.js app; design tokens, Manrope, shadcn base; **landing page** (all PRD §17.4 sections, working hero input, suggested prompts, motion with reduced-motion support); migrations 0001–0004 + seed; anonymous session; workspace shell with 5 tabs | AT-01 (hero text persists), AT-02 (page usable without typing), AT-15 (mobile); `next build` passes |
| **M2 · Business discovery** (discovery consultant + AI team proposal; scope extended by the owner, 2026-11-05) | Nov 5–6 (done) | 1–4 | Five-stage consultant (introduce → discover → analyse → confirm summary → review team); "What I understand" panel with confirmed / unconfirmed / unknown fields; grounded business analysis (every insight cites the owner's messages or answers); editable summary and confirmation; **capability catalogue, deterministic team proposal, agent cards, configure / remove / approve** (moved from M3); AI provider layer with `mock` (offline rules) and the `nearai` adapter (built, not used: no live calls); "AI mode" badge; local development store shaped like the approved tables. **Nothing is generated, deployed or executed.** | AT-01, AT-03, AT-04, AT-05: a restaurant gets Orchestrator + Order, Inventory, Procurement, Finance; a salon gets a smaller team with honest "Preview" labels. Done — see the [M2 report](poc-results/m2-report.md). |
| **M3 · Workflow generation, validation and approval** (was "AI team"; the team proposal moved into M2) | Nov 6 (done) | 5 | Workflow schema (8 step types), restaurant template, deterministic generation (no AI), path-based validator, read-only diagram + list, owner settings (illustrative NGN), **approve workflow** (versioned; approving runs nothing); Team and Workflows tabs; restaurant is the only runnable scenario (others Preview); labelled demo data. Local development store (M2 D2) until Supabase is approved. | AT-06: an invalid workflow can't be approved. **Done:** commit `333a75c`, see the [M3 report](poc-results/m3-report.md). |
| **M3.5 · Discovery intelligence** (inserted 2026-11-06, owner decision; **approved and implemented 2026-11-06, awaiting review**: [report](poc-results/m3.5-report.md)) | Nov 7–9 (3-day timebox) | 2–4 | Rebuild the discovery architecture, not just the prompts, in four phases ([M3.5 proposal](m3.5-proposal.md), from the [diagnosis](discovery-reasoning-proposal.md)): **P1** stop misfiling and silent overwrites; **P2** case-file model (facts, the owner's unverified claims, problem tree with possible causes, question agenda, contradictions) with the ten profile fields kept as a compatible view; **P3** offline diagnostic playbooks (restaurant in depth; others lighter, with an honest fallback); **P4** analysis and agent recommendations grounded in problems and their causes. Offline only: **no AI provider calls**; NEAR AI (P5) needs separate approval | M3.5 acceptance criteria AC-1 to AC-16 ([M3.5 proposal](m3.5-proposal.md)); the reference restaurant conversation still yields the Orchestrator + Order, Inventory, Procurement and Finance Agents, each justified by a stated problem and its cause; all M2/M3 tests still pass |
| **M4 · Workflow execution and agent collaboration** (test runs) | Nov 10 | 6 | **Depends on M3.5.** In-process runner for the approved workflow ("Run demo order"); the Orchestrator and four specialist agents with typed handoffs; **live collaboration timeline**; deterministic security gate on demo data, approval queue, in-app kill switch (pending the [M4 proposal](m4-proposal.md) decisions); payment step in `test_run` mode until M5; each run shows which confirmed business problem the workflow addresses | AT-06, AT-07, AT-09 and AT-11 (test-run forms); a demo order runs end to end off-chain with every handoff visible; "Test run — no transaction" labels |
| **M5 · NEAR integration and real on-chain transactions** (NEAR **testnet**; Gate 4 vertical slice) | Nov 11–12 | 7–8 | Treasury contract + unit tests; `scripts/provision-testnet` (you run it); `config.yaml` → policy → on-chain `set_policy`; security gate **network signals** (the rule core and approvals arrive in M4 if D1/D3 are approved), on-chain pause wired to the kill switch; signer wrapper; customer `pay_order` + agent `request_payment`; ledger + public page; elapsed timer | **The full journey works on testnet.** AT-08 (ALLOW, paid), AT-09 (WARN, approved, paid), AT-11 (kill switch), AT-13 (key revoked); explorer links; **measured sale-to-payout under 2 min** (B8) |
| **M6 · Security track evidence (Gate 5)** | Nov 13 (morning) | 7 | Blocklist report UI and API with evidence; `npm run demo:attack` (**Part B, the scripted compromised agent, is always run**; Part A, live LLM, runs only if inference is approved, otherwise it's logged as "not run"); README key-limits section; tests (gate rules, signer refusal, two-user isolation, idempotency) | AT-10; the attack log shows BLOCK and no transaction; every track claim matches evidence |
| **M7 · Polish, README, video** | Nov 13 (afternoon) | all | **Polish pass:** copy, empty and loading states, error states, motion timing, accessibility (labels, focus, contrast), mobile layouts. **Local run documented step by step** (a hosted demo only on an approved free tier, D-10). Final README judge steps with **measured** results. Screenshots. Demo-video script (you record it). | Fresh clone plus README works (AT-14 credential-free paths); Playwright happy path green on desktop and mobile |
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
Gate 1 ─► M0 ─► M1 ─► M2 ─► M3 ─► M3.5 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8
            └── PoC-B (testnet + contract) de-risks M5, the hardest milestone
```

- The **treasury contract** (`contracts/`) only touches its own files, so it could start right after PoC-B, in parallel with M1–M4, if you want a second session for it.
- **Why M3.5 sits before M4** (owner decision, 2026-11-06): discovery, analysis and the agent recommendations are upstream of workflow execution. M4 must not execute workflows built on a misunderstood business problem.
- **Work that can run in parallel with M3.5 and M4** (each needs your go-ahead): the treasury contract (`contracts/`, its own files only, in a separate session) and your own testnet provisioning (`scripts/provision-testnet`, free testnet only). Both shorten M5.
- **Cut order if behind** (P0 is never cut silently; a P0 shortfall removes that track from the submission):
  1. on-chain pause from the UI (owner script stays)
  2. second business-type polish
  3. hosted demo (keep local + video, Q-012)
  4. blocklist report UI (keep the API + seeded fixture)
  5. M3.5: lighter retail and salon playbooks (restaurant depth is kept; others use the honest fallback)
  6. M4: agent-level pause and run-history UI (run controls and the business kill switch are kept)
  7. M7: reduced to the README, judge steps and video script

## Revised timeline and risks (2026-11-06)

Eight working days remain (Nov 7–14). The estimated work is about 8.5 days, so **there is no slack**; the cut order above is what absorbs overruns.

| Day | Milestone | Estimate | Notes |
|---|---|---|---|
| Nov 6 (rest of day) | Reviews and approvals | — | M3.5 scope, M4 decisions D1–D14 |
| Nov 7–9 | **M3.5 · Discovery intelligence** | 3–4 days, **timeboxed at 3** | P1 first (half a day) removes the worst behaviour; P2 → P3 → P4 |
| Nov 10 | **M4 · Workflow execution and agent collaboration** | ~1 day | Starts only when M3.5's acceptance criteria pass |
| Nov 11–12 | **M5 · NEAR testnet** | ~2 days | Shorter if the contract and provisioning ran in parallel; the gate core already exists after M4 |
| Nov 13 | **M6 + M7** | half a day each | The attack demo reuses the M4 gate; polish limited to the judge path |
| Nov 14 | **M8 · Submission** | half a day | Before 23:59 UTC |

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| M3.5 overruns its timebox | Medium | M4 and M5 slip; less polish | Timebox; P1–P2 are mandatory, P3 restaurant depth next, then P4; lighter playbooks for other industries |
| M5 testnet work takes longer (contract, keys, provisioning on Windows) | Medium | Business-track evidence (real testnet payouts) at risk | PoC-B already proved the toolchain; start the contract and provisioning in parallel (needs approval) |
| Compressed M6 + M7 | High | Weaker security evidence or polish | The gate core and approvals from M4 do much of M6's work; the video script is drafted during M5 |
| Changes to the case-file data model break M2/M3 consumers | Low–medium | Regressions | The ten-field compatibility view; all 74 existing tests must pass; migration tested |
| A grounded team for a real owner's restaurant differs from the five-agent demo team | Medium | M4 runs a reduced template | The M3 template already handles missing agents; the reference conversation used for the demo must yield all five, each justified by a cause |
| Total slack is zero | High | Missed deadline | Daily check against this table; the cut order is applied early, never silently |
