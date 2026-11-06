# 09 · Zero-additional-spending development plan

Status: **Owner directive, 2026-11-05. Overrides any paid step elsewhere in these documents.**

> **Clarification (owner, 2026-11-05, after PoC-A): NEAR AI Cloud stays mandatory** for EmployAI's actual AI functionality and the **final live demonstration**. The `mock` provider is for **development, automated tests, and a clearly labelled offline mode**. It is never presented as the real product AI. Live NEAR AI usage for the final demo needs a separately approved budget.

## Rules

1. **No paid NEAR AI API calls.** No inference calls of any kind are made without your explicit approval, per call batch.
2. **No subscriptions, upgrades, paid hosting or paid services.**
3. **No credits consumed** without your explicit approval.
4. **NEAR testnet only, free faucet funding only.** Creating or funding any account needs your approval first.
5. **Mock AI, fixtures and local tests** stand in wherever real inference isn't approved.
6. **The AI provider stays configurable,** so NEAR AI Cloud connects later by changing environment variables, not code.
7. **The product vision is unchanged.** All 8 journey steps are still built and demonstrable.

## The key design change: development and tests work fully without an LLM

Every place that uses an LLM also has a **deterministic baseline** that does the job on its own. Development, tests and CI therefore cost nothing, and NEAR AI Cloud is switched on through configuration, not code, for the real product and the final demo.

| Journey step | `AI_PROVIDER=mock` (development, tests, offline mode) | `AI_PROVIDER=nearai` (real product AI, final demo; needs approval) |
|---|---|---|
| 2. Discovery questions | **Rule-based consultant.** Keyword and pattern extraction fills the profile (business type, channels, products, team size, tools, pain points). The next question is chosen from the highest-priority **unknown** field, using a question bank per business type (restaurant, salon, retail, services, generic). The summary comes from a template. | The same schema and UI. The LLM extracts facts and phrases the questions, and its output is validated with zod. |
| 3. AI team | **Deterministic mapping**: profile facts → capabilities in the catalogue → agent definitions from templates (purpose, tools, limits, never-does) | The LLM refines the wording and rationale, still limited to catalogue capabilities |
| 5. Workflows | Already template-based and deterministic | The LLM chooses template parameters (thresholds, quantities) |
| 6. Procurement recommendation | **Scored comparison** of the 3 quotes (price, delivery, approval status), with a templated rationale | The LLM writes the rationale and recommendation; the gate still decides |
| 7. Attack demo | **Part B** (a scripted, fully compromised agent) proves enforcement, with no AI needed. Part A (live LLM) is skipped and logged as "not run (no AI provider enabled)". | Part A runs as well |

The interface the rest of the app calls (`lib/ai/provider.ts`):

```text
AiProvider
  structured<T>({task, schema, system, user, maxTokens}) → { data: T, provider, model, mode, usage, costUsd, inferenceId? }
  toolCall({task, system, user, tools, maxTokens})        → { data: {name, args}, provider, model, mode, usage, costUsd, inferenceId? }

Implementations (validated offline in M0 / PoC-A0: 42 tests, spikes/poc-a0)
  mock    — deterministic rules; cost 0; mode "offline-demo"; no network
  nearai  — openai SDK → NEAR_AI_BASE_URL, maxRetries 0, timeout; refused unless NEAR_AI_CALLS_APPROVED=true,
            NEAR_AI_MAX_CALLS > 0 and NEAR_AI_MAX_USD_PER_DAY > 0; catalogue checked at start-up
            task routing (PoC-A): discovery_turn → Qwen/Qwen3.8-27B (strict JSON schema)
                                  procurement_decision → anthropic/claude-haiku-5-5 (tool call)
  ollama  — optional local model; requires OLLAMA_MODEL (nothing is downloaded automatically)

AI_PROVIDER has NO default: it must be set explicitly, so the app can never drift into mock mode by accident.
A failing provider raises a typed error (AUTH, CREDITS_EXHAUSTED, RATE_LIMITED, UPSTREAM, TIMEOUT,
SCHEMA_INVALID, TRUNCATED, NO_TOOL_CALL, BUDGET_CAP, CALL_LIMIT, USAGE_MISSING, PRICE_UNKNOWN).
It is never silently replaced by mock. The UI shows "AI unavailable" with the reason.
Agent selection, security decisions and transaction validation are deterministic code in every mode.
```

**Spending safeguards in code:**
- The `nearai` provider refuses to start unless `AI_PROVIDER=nearai`, `NEAR_AI_CALLS_APPROVED=true`, `NEAR_AI_MAX_CALLS` > 0 and `NEAR_AI_MAX_USD_PER_DAY` > 0 are all set.
- Before each call, the **worst case** (conservative input estimate + `max_tokens` × live catalogue price) is checked against the daily USD cap and the call ceiling. The request is refused **before any HTTP traffic** if either would be exceeded.
- After each call, real `usage` × price is recorded. A response without usage, or with more output tokens than `max_tokens`, is charged at worst case and stops further calls (spending can't be capped reliably). A failed request is charged at worst case too.
- **SDK retries are disabled** (`maxRetries: 0`). The `openai` SDK otherwise retries twice by default; PoC-A0 found this and a mutation test proves the guard.
- Billed costs are reconciled through `POST /v1/billing/costs`, and mismatches over 50 % are flagged.
- Tests never call the real `nearai` endpoint (they use a local mock server), and CI has no key.

**Honest labelling:** the UI shows an "AI mode" badge on every AI-produced screen: **"Offline demo AI (rule-based)"**, **"Local model (Ollama)"** or **"NEAR AI Cloud"**. The README states which mode the demo video used.

**Fixtures:** `fixtures/ai/*.json` hold the expected structured outputs for the restaurant and salon scenarios. They're used by unit tests and by the mock provider's edge cases. If you later approve real calls, recorded real responses can be saved as fixtures, so tests stay free.

## Free resources only

| Need | Free option | Status |
|---|---|---|
| Inference during development | `mock` (rules); optional **Ollama** local model (installed, **no models downloaded**; a ~1–3 GB download needs your approval) | Development and tests: mock |
| Real NEAR AI Cloud (mandatory for the final demo) | Your existing NEAR AI key (PoC-A spent $0.012238 of it). The final-demo budget needs separate approval; estimated cost per demo session is in the M0 report. | Per-batch approval |
| Database + auth | **Supabase free tier**. Its limits and sign-up requirements (for example whether a card is asked for) are **not yet verified by me**; I'll check their live pricing page before you sign up. Alternative with no sign-up at all: D-23. | Needs your approval and sign-up |
| Blockchain | NEAR **testnet** + free faucets (near-cli `sponsor-by-faucet-service`, near-faucet.io) | Needs your approval before account creation |
| Chain data | Public testnet RPC (FastNEAR) and the NearBlocks free tier, no key | ✅ Already verified, free |
| Contract tooling | Rust, cargo-near, near-cli-rs (installed, free) | ✅ |
| Testing | Vitest, Playwright (local) | ✅ |
| Hosting | **None by default.** Run locally, and record a **demo video** (HACKATHON.md Q-012 accepts local-only demos with a public repo, reproducible README and a video). A free hosting tier is only considered if you approve it and it needs no payment details. | Local + video |
| Repo | GitHub public repo (free) | Gate 6 |

## Features that can't be fully validated without paid (or credit-consuming) resources

| Feature | What we *can* validate for free | What stays unvalidated |
|---|---|---|
| **Real NEAR AI Cloud inference** | ✅ **Validated by PoC-A** ($0.012238): structured output (Qwen), tool calls (Haiku), latency, `inference-id`, the billing API. ✅ Adapter error handling and spending controls validated offline (PoC-A0, 42 tests). | A real 402 from an exceeded **provider-side** spend limit (only mocked); rate limits; the end-to-end app flow with live AI (needs a budget at M2 or later) |
| **LLM conversation quality** (natural, adaptive questions; nuanced extraction for unusual businesses) | The rule-based consultant for the restaurant, salon, retail and services question banks, plus a generic fallback | Truly open-ended understanding of arbitrary businesses. The rule-based mode is labelled as such. |
| **`business` track: "maximum inference spend per day"** | The cap logic (PoC-A0), plus PoC-A showing our estimate matches the real bill within 1 % | Enforcement observed live inside the app (final demo, with an approved budget) |
| **`business` narrative: "the agent buys its own inference from NEAR AI Cloud"** | Already documented as not possible on testnet; we only claim metered, owner-funded inference | Unchanged (it was never claimable) |
| **`security` attack demo, Part A** (does a live LLM take the injection bait?) | **Part B** fully demonstrates the mandatory requirement: an injected, compromised agent tries to pay a known-bad address, gets BLOCK, and no signature or transaction happens | Part A, until real or local inference is approved |
| **Hosted demo** | Local run + video + README (allowed by Q-012) | Judges can't click a live URL unless a free host is approved |
| **Supabase hosted project** | If you'd rather not sign up at all: unit-test everything that doesn't need a DB, and decide a local fallback (D-23) | RLS and auth behaviour in a real Supabase project |

**Not affected (fully free and real):** the treasury contract, the function-call key, testnet sale and revenue split, the supplier payout, the security gate with live testnet signals (RPC + NearBlocks), approvals, the kill switch, the public ledger with real explorer links, the workflow engine, the agent collaboration, and the UI.

## Track-requirement impact

Both formally targeted tracks stay fully achievable at zero cost:

- **`business`:** own NEAR account ✅, function-call key ✅, `config.yaml` rules ✅, public ledger ✅, testnet loop under 2 minutes ✅. **The final demo uses NEAR AI Cloud** (budget to be approved). Offline mode is only for development and tests, and is labelled.
- **`security`:** all mandatory items are free (the counterparty check, the 4 signals from free sources, the wrapper, the function-call key, and the attack demo via Part B).
