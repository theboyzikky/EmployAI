# EmployAI architecture — Gate 1 (simplified scope)

Status: **Revised 2026-11-05. Tracks are final: `business` (primary) + `security` (secondary). Zero-additional-spending directive in force ([09](09-zero-spend-plan.md)). The remaining decisions below still await approval.** Nothing is implemented yet: no application or contract code, no testnet accounts, no AI API calls.

EmployAI is a hackathon **prototype** that shows one idea working end to end: *describe your business, and EmployAI designs, builds and safely runs an AI workforce for it.* Scope, track choices and cuts are set in **[00-mvp-scope.md](00-mvp-scope.md)**, which overrides everything else here.

| # | Document | Contents |
|---|---|---|
| 00 | [MVP scope](00-mvp-scope.md) | The 8-step demo journey, track decision, in/out of scope, success criteria |
| 01 | [Requirements mapping](01-requirements-mapping.md) | `business` and `security` requirements → implementation, module, test, evidence; `swarms` removed |
| 02 | [Architecture](02-system-architecture.md) | One Next.js app + Supabase + one treasury contract; 5 diagrams |
| 03 | [Database](03-database-design.md) | 11 tables, RLS, 4 migrations |
| 04 | [API](04-api-design.md) | 18 endpoints, auth, errors |
| 05 | [Threat model](05-threat-model.md) | Six threat categories, gate rule order, **signal data sources** (security checkpoint) |
| 06 | [Dependencies](06-dependencies.md) | Services, 9 testnet accounts, packages, models, environment variables |
| 07 | [PoCs](07-technical-pocs.md) | Free spikes: offline AI provider contract, testnet treasury, database; real NEAR AI deferred |
| 08 | [Milestones](08-milestones.md) | M0–M8, Nov 5–14, with a polish day; **submission plan** |
| 09 | [Zero-spend plan](09-zero-spend-plan.md) | No unapproved spending; NEAR AI Cloud for the product and final demo; offline provider for development and tests; no silent fallback |
| — | [M0 report](poc-results/m0-report.md) | Results of the free M0 work and the outstanding requirements |
| — | [M1 report](poc-results/m1-report.md) · [M2 report](poc-results/m2-report.md) | Landing page and handoff · AI business consultant, analysis and team proposal |

## The prototype in one paragraph

A visitor describes their business in the landing-page hero. A consultant (offline demo AI by default; NEAR AI Cloud once approved) asks a few focused questions, fills in a live "What I understand" panel and confirms a summary. EmployAI proposes an AI team from an industry-agnostic **capability catalogue**, and the owner approves it. Workflows are generated from **templates**, validated and deployed. "Run demo order" shows the restaurant's Business Orchestrator delegating to the Order, Inventory, Procurement and Finance agents, **collaborating on a live timeline**. The supplier payment passes a deterministic **security gate** (ALLOW, WARN with owner approval, or BLOCK) and is executed on **NEAR testnet** by the Finance Agent's **function-call key** through a **treasury contract**. The contract also enforces the owner's `config.yaml` policy and splits each customer payment automatically to a contributors' account. A **public ledger** shows every sale, inference cost and payout. On-chain rows have explorer links, and nothing simulated is presented as on-chain.

**What changed from the first Gate 1 proposal:**
- One app instead of app + worker + queue
- 11 tables instead of about 35
- 18 endpoints instead of about 35
- 9 testnet accounts instead of 35
- 1 contract instead of 2
- 3 free PoCs instead of 10 (real NEAR AI deferred under the zero-spend plan)
- no swarm, webhooks, connectors, wallet connect, OutLayer or Intents

The full earlier version is kept in a session backup and can be restored on request.

## Decision log (owner decisions)

| Date | Decision | Effect |
|---|---|---|
| 2026-11-05 | **Simplify to a polished prototype** of the 8-step journey | Scope in 00; one app, 11 tables, 1 contract |
| 2026-11-05 | **Tracks: `business` (primary) + `security` (secondary). `swarms` removed as an implementation and submission target.** | No marketplace, swarm sub-accounts, coordinator, sealed bids or collective purchasing. The internal Orchestrator + four-agent collaboration stays. Submission `tracks: ["business","security"]`. |
| 2026-11-05 | **Zero additional spending** | No paid AI calls, credits, subscriptions or hosting without explicit approval. Free testnet only, with account creation and funding approved first. See 09. |
| 2026-11-05 | **PoC-A Tier 1 approved and run** | 36 calls, billed $0.012238 (cap $0.05). Tier 2 not approved. |
| 2026-11-05 | **NEAR AI Cloud is mandatory** for the real AI functionality and the final live demo. Architecture: **Qwen** for structured discovery (subject to final integration checks), **Haiku** for tool calls, **deterministic rules** for agent selection, **deterministic code** for security and transactions. No TEE claim for any model without verification. | `mock` is for development, tests and a labelled offline mode only; `AI_PROVIDER` has no default; failures never fall back to mock. |

| 2026-11-05 | **M1 approved** (application foundation and landing page) | Built. See [M1 report](poc-results/m1-report.md). |
| 2026-11-05 | **Database: Supabase Free** (PostgreSQL, Supabase Auth, RLS). No paid plan, no charges. | Free-tier terms checked on the live pricing page 2026-11-05: **$0/month**, 2 active projects, 500 MB database, shared CPU / 500 MB RAM, 5 GB egress, 1 GB storage, 50,000 MAU, anonymous sign-ins included, community support. **Projects pause after 1 week of inactivity**, and there are **no automatic backups**. The page does not state whether a card is required or what happens when Free limits are exceeded. The project is not created yet (needed from M2). |
| 2026-11-05 | **AI provider:** NEAR AI Cloud mandatory for discovery, follow-up questions, business analysis, agent recommendations and operational reasoning. Qwen + Haiku provisional; models configurable. Mock is for offline development and tests only, with no silent fallback. No paid calls during M1. | Unchanged architecture (09) |
| 2026-11-05 | **Design system:** Manrope weights **300 / 400 / 500 / 600 / 700** (800 and 900 forbidden); Black `#111111`, Deep Purple `#482477`, Pale Lavender `#F3EFF9`, Soft White `#F8F8FA`; black primary and black-outline secondary buttons, purple hover. **Supersedes PRD §17.2/§20, which allowed 300–500.** | Implemented in `src/app/globals.css` |
| 2026-11-05 | **Icons: Phosphor only** (`@phosphor-icons/react`): Regular by default; the **same icon's Fill** on hover, selected and active; muted Regular when disabled. **Supersedes PRD §17.2/§20 (Lucide).** | Implemented in `src/components/icons` |
| 2026-11-05 | **TypeScript 5** (D-18 resolved): the official `create-next-app@16.4.5` template pins `typescript ^5` (5.9.3), not 7 | — |

| 2026-11-05 | **Landing-page design corrections** | Headline is exactly "Build your Business' AI Workforce.". Purple limited to Deep Purple `#482477` + Pale Lavender `#F3EFF9` (the extra "purple-light" tint was removed). Icons: Regular everywhere; Fill **only** inside interactive elements while hovered, focused, pressed, selected or expanded. **Light / Dark mode** added: theme variables, a navbar toggle, persisted in `localStorage`, applied before first paint. Dark mode uses neutral surfaces; accent text there is deep purple mixed into pale lavender (same palette) for readable contrast. |

| 2026-11-05 | **Exact colour palette** (owner reference): Violet 100 `#EDE9F1` · 200 `#E4DEEB` · 300 `#C6BBD5` · Secondary `#482477` · 500 `#41206B` · 600 `#3A1D5F` · 700 `#361B59` · 800 `#2B1647` · 900 `#201036` · 1000 `#190D2A`; Black 100 `#F6F6F6` · 200 `#E6E6E6` · 300 `#D9D9D9` · 400 `#B0B0B0` · Primary `#000000`. **Supersedes the 2026-11-05 palette above (`#111111`, `#F3EFF9`, `#F8F8FA`).** | Black dominant; Violet Secondary is the brand accent; dark violets for depth and selected states. Light-mode secondary text is Primary black at 64 % opacity (the palette has no readable mid-grey). Hero decorations are borderless symbols, not UI tiles. |
| 2026-11-05 | **Product film section** "Watch your business come to life." between How It Works and Meet Your AI Workforce | Scroll-driven, four scenes plus a finale, no new dependencies; static storyboard under reduced motion / no JavaScript; labelled as an illustration with simulated data. |
| 2026-11-05 | **Dark Mode is the default theme.** First-time visitors get Dark Mode (also without JavaScript); a theme chosen with the toggle is stored (`localStorage` `eai-theme`) and always wins on later visits, refreshes and pages, including onboarding. Dark surfaces are black and dark neutrals (Primary black lifted with Black 100, no hue); violet only for accents. | The system `prefers-color-scheme` setting no longer decides the first theme. |
| 2026-11-05 | **M2 approved with decisions D1–D6** | D1: the AI workforce proposal, configuration and approval move into M2 (workflow generation, deployment and execution stay later). D2: a local development store shaped like `businesses` / `messages` / `agents`, explicitly **not production persistence**, until Supabase is created. D3: profile extended to 10 fields; every analysis insight cites the owner's messages or answers, and assumptions are labelled. D4: five-stage progress (Introduce → Discover → Analyse → Confirm summary → Review team). D5: the consultant's reply returns in the same request; failures keep the owner's message. D6: `openai` 7.50.0 and `vitest` 5.1.0 added; `.env.example` lists `AI_PROVIDER` and the NEAR AI safeguards; `AI_PROVIDER=mock` set explicitly in the local `.env` only, never as a default. See the [M2 report](poc-results/m2-report.md). |
| 2026-11-06 | **M3 approved with changes 1–6** | Workflow generation, validation, review and **approval**; execution is M4. Workflows are *approved*, never *deployed*: status `draft`/`approved`/`superseded`, `approved_at`, `POST …/workflows/:wid/approve` (no `/deploy`). The restaurant demo is the only runnable scenario; other industries keep discovery and the proposed team as Preview. The fictional restaurant menu, stock and suppliers live in `scenario_data`, are always labelled demo data and are never mixed with the business profile. Payment settings are illustrative NGN; NEAR contract limits and network fees are set separately in M5, with no currency conversion. A payment's **beneficiary** (an approved supplier chosen by Procurement) is separate from its **channel** (the treasury contract, `request_payment`). The validator checks payment safety on every execution path; invalid workflows can't be approved. No AI calls in M3; local development store continued. See the [M3 report](poc-results/m3-report.md). |
| 2026-11-06 | **M3 review decisions** | Accepted: `WORKFLOW_INVALID` is `409`; `workflows/generate` returns `200 { view }` (synchronous, no polling). **Payment approval rule (future execution behaviour, not executable in M3):** every payment path contains a security check followed by an owner approval control. Manual owner approval is required when the amount exceeds the configured threshold or the security gate returns WARN; an ALLOW result at or below the threshold needs no additional manual approval. Landing copy reworded to "Build, validate and approve workflows" and controlled workflow creation (no deployment claim). |
| 2026-11-06 | **Sub text is ash, with moderate line spacing** | Secondary text (`--eai-muted`) is a lighter ash in light mode (Primary black at 58 %, ≈ #6b6b6b, was 64 %) and a darker ash in dark mode (Black 400 at 80 % into Primary black, ≈ #8d8d8d, was #b0b0b0). Both are at least 4.8:1 on every surface. Small text (xs, sm) uses 1.5 line spacing, and secondary text no longer uses `leading-snug`. Applies to the whole app. Supersedes the earlier muted values in the colour-palette entry. |

**PRD items descoped by these decisions:** PRD §7.1 "Swarm module", FR-18, AT-12, §14 (AI Swarms procurement market), the swarm parts of §22, and Appendix C as an implementation target. Appendix C stays in `docs/PRD.md` as reference text. The PRD itself is unchanged; this log records the deviation.

## Decisions still open

My recommendation comes first in each row.

| ID | Decision | Recommendation | Alternative |
|---|---|---|---|
| D-04 | Wording for "agent buys its own inference" | "Metered, owner-funded inference with a daily cap and per-agent cost tracking" (autonomous purchase isn't possible on testnet) | — |
| D-05 | Models | **Decided from PoC-A:** Qwen 3.8 27B for structured discovery (subject to final integration checks), Haiku 5.5 for tool calls, deterministic rules for agent selection, deterministic code for security and transaction checks | — |
| D-10 | Hosting | **Local run + demo video** (free; Q-012 accepts it) | A free long-running host, only if you approve one that needs no payment |
| D-17 | Attack demo | **Part B always** (scripted compromised agent, free, meets the requirement); Part A (live LLM) only if inference is approved | — |
| D-24 | NEAR AI budget for integration checks and the final demo | Approve a small, capped budget when M2 is ready for live checks (estimate in the M0 report) | Use offline mode for development until then |
| D-19 | Runner hosting model | **In-process runner on a long-running Node server**, steps persisted, "Resume" after a restart | Serverless (would need a queue, which brings back infrastructure) |
| D-20 | Demo customer payment | The server signs the demo customer's `pay_order` with a **demo-customer key** (a separate account with a small testnet balance, clearly labelled, **not an agent key**) | Visitors pay from their own testnet wallet (adds wallet connect) |
| D-21 | Second business type to showcase | **Hair salon** (bookings, reminders, payments) to prove the concept is industry-agnostic, with honest "preview" labels | Online shop |
| D-22 | On-chain pause from the UI | P1 (guardian key). In the MVP the in-app switch acts instantly, and on-chain `pause` runs via an owner script. | P0 |

## Checkpoints this gate covers

- **`business`:** "sketch the architecture in text and wait for my OK" → 02.
- **`security`:** "List the data sources … then wait for my OK" → 05 §4.
- **`swarms`:** removed as a target, so its checkpoint (RULES.md and a round diagram) doesn't apply.
