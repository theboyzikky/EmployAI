# M0 report · free technical checks

Date: **2026-11-05**. Scope: the remaining **free** M0 work approved by the owner. Constraints honoured:
- no NEAR AI calls beyond the approved PoC-A
- no testnet accounts created or funded
- no models downloaded
- no paid services or expenses

## Summary

| Check | Result |
|---|---|
| PoC-A · real NEAR AI Cloud (approved, Tier 1) | ✅ 36 calls, **billed $0.012238** (cap $0.05). Qwen: strict JSON 5/5. Haiku: tool calls 10/10, strict JSON 0/8. Both resisted 10/10 injections. [Report](poc-a.md) |
| PoC-A0 · offline provider layer (`mock` + `nearai` adapter against a local mock server) | ✅ **42/42 tests pass**, $0, no external network (`spikes/poc-a0`) |
| Provider switching `mock` ↔ `nearai` (↔ optional `ollama`) | ✅ Only env variables change, no code. `AI_PROVIDER` has no default. |
| Structured-response validation and error handling | ✅ 13 failure modes mapped to typed errors, each with exactly 1 HTTP request |
| Spending controls with mock billing | ✅ Pre-call cap, call ceiling, worst-case charging, day rollover, billing reconciliation |
| No silent fallback from NEAR AI to mock | ✅ Every failure rejects; source check; catalogue failure at start-up rejects |
| Ollama | ✅ Optional and config-validated only. **No model downloaded.** |
| Treasury contract toolchain on Windows (PoC-B, the part that needs no accounts) | ✅ **12/12 unit tests pass; wasm builds (143 KB).** Two Windows workarounds, no installs. See §4. |
| TEE wording | ✅ Removed every unverified TEE or privacy claim about Qwen from the docs |

## 1. PoC-A0: offline validation of the AI provider layer

Location: `spikes/poc-a0` (throwaway spike, not the app). Run it with `cd spikes/poc-a0 && npm test`. It uses Node 26's built-in test runner, with `openai@7.50.0` and `zod@4.6.7` as its only dependencies. Tests point the real `openai` SDK at a **local** HTTP server (127.0.0.1) that returns NEAR AI's documented response shapes. The tests never read `.env`, and they were run with `NEAR_AI_API_KEY` removed from the environment.

| Group | Tests | What it proves |
|---|---|---|
| 1 · Offline mock provider | 7 | Restaurant text → schema-valid facts and `ready_for_summary`. A salon gets a salon-specific question; an unknown business gets a generic one. Deterministic output. Procurement picks the cheapest **approved** supplier and ignores a cheaper unapproved one. A scam-only quote → `no_action`. An unknown task → error, never a generic fake answer. **`fetch` is replaced with a function that throws, so any network use fails the test.** |
| 2 · Provider switching | 8 | Unset or unknown `AI_PROVIDER` → CONFIG error. `nearai` refuses without `NEAR_AI_CALLS_APPROVED=true`, a valid key, a call ceiling > 0 and a daily USD cap > 0, and makes no network call when refused. HTTPS is required (except localhost, for tests only). A model missing from the catalogue → CONFIG. `ollama` without `OLLAMA_MODEL`, or with a non-local URL → CONFIG. |
| 3 · `nearai` adapter | 16 | Valid structured output parsed, labelled `live`, `inference-id` captured, cost computed from usage. The request carries strict `json_schema`, `max_tokens`, `temperature 0`, and Qwen `enable_thinking=false`. Tool calls go to Haiku with `tool_choice: required`. **13 failure modes → typed errors, each with exactly one HTTP request:** bad JSON, schema mismatch, truncation, bad tool arguments, no tool call, two tool calls, 401, 402, 429, 500, timeout, missing usage, usage above `max_tokens`. |
| 4 · Spending controls | 7 | A call is refused **before any HTTP request** if its worst case would exceed the daily cap. The cap accumulates and stops further calls. The max-calls ceiling holds. A failed request is charged at worst case. A missing price → refuse. The cap resets on a new day. Billing reconciliation passes when the bill matches and **flags a bill 3× higher**. |
| 5 · No silent fallback | 3 | A catalogue outage at start-up → `createProvider` rejects. 500, 402, timeout and bad JSON all reject, with no mock result. A source check finds the live adapter has no mock imports or references, and `MockProvider` is constructed only in the explicit `mock` branch. |
| 6 · Secrets | 1 | The key never appears in error messages or stacks across 5 failure modes. Every request carried the correct auth header. |

**Mutation check:** with the SDK's retries switched back on (`maxRetries: 2`, the SDK default), **6 of the "exactly one request" tests fail**. They pass again after restoring `maxRetries: 0`. So the tests really detect retries.

**Finding:** the `openai` SDK **retries failed requests twice by default** (`maxRetries=2`). Unless that's disabled, one 429, 5xx or timeout would turn into up to 3 billed attempts. The adapter sets `maxRetries: 0`.

## 2. AI architecture, from PoC-A and PoC-A0

| Responsibility | How it's done | Evidence |
|---|---|---|
| Discovery extraction and next question | NEAR AI · `Qwen/Qwen3.8-27B` · strict `json_schema`, reasoning off · zod re-validation | PoC-A T2 5/5. **Subject to final integration checks** with the real app prompts (M2). |
| Procurement recommendation | NEAR AI · `anthropic/claude-haiku-5-5` · forced tool call · zod-validated arguments | PoC-A T4 5/5, T5 5/5 |
| Selecting the business's agents | **Deterministic rules** (profile → capability catalogue) | PoC-A T3: neither model reliably produced the right team |
| Security decisions, transaction validation | **Deterministic code** (gate + signer wrapper) **and the treasury contract** | Design; contract rules in §4 |
| Development, tests, CI | `mock` provider, labelled "Offline demo AI", $0 | PoC-A0 |
| Failure behaviour | Typed error → "AI unavailable" in the UI. **Never a silent switch to mock.** | PoC-A0 group 5 |

**No model is described as TEE-protected** anywhere in the docs; that would need its inference environment verified.

## 3. Estimated NEAR AI cost for the final demo (from PoC-A actuals; not approved yet)

| Item | Calls | Cost per call (PoC-A actual) | Cost |
|---|---|---|---|
| One onboarding (about 6 discovery turns, Qwen) | 6 | ≈ $0.00028 | ≈ $0.0017 |
| One demo order (1 procurement decision, Haiku) | 1 | ≈ $0.0002 | ≈ $0.0002 |
| **One full demo session** | ≈ 7 | | **≈ $0.002** |
| Integration checks at M2 and M4 (suggested cap) | ≤ 60 | | **≤ $0.05** |
| Rehearsals plus recording the video (suggested cap) | ≤ 150 | | **≤ $0.10** |

These are estimates. Every batch would run with the in-code daily cap set to the approved amount.

## 4. Treasury contract toolchain on Windows (PoC-B, no accounts)

Location: `spikes/poc-b-treasury` (throwaway spike, **not deployed**, no accounts). It was scaffolded with the official `cargo near new` (as the NEAR skill requires), and the template's sample auction contract was replaced with a minimal treasury.

| Check | Result |
|---|---|
| Toolchain | The template pins **Rust 1.93.0**, which rustup auto-installed (free). `cargo-near` 0.22.0. |
| Contract rules implemented | `pay_order` (minimum order value, automatic revenue-share transfer, `sale` event); `request_payment` (registered agent only, not paused, approved recipient, per-transaction limit, daily cap with day rollover, duplicate `request_id` rejected, transfer + callback that rolls back the day's counter if the transfer fails); owner-only `pause` / `unpause` / `approve_recipient` / `set_agent`; views |
| **Unit tests** (`cargo test --lib`) | ✅ **12/12 pass.** Sale splits 10 % to contributors and logs an event; below-minimum sale rejected; the agent pays an approved recipient; another caller rejected; **an unapproved recipient is rejected even for the agent**; over per-transaction limit rejected; daily cap enforced; cap resets the next day; duplicate request rejected; pause blocks the agent; **the agent can't unpause**; a revoked agent is rejected |
| **WebAssembly build** (`cargo near build non-reproducible-wasm --no-abi`) | ✅ Built on Windows: `poc_b_treasury.wasm`, **143 002 bytes**, valid wasm magic, SHA-256 `285c216f…0d5a`. No compiler warnings in the contract code. |

**Windows issues found and solved without installing anything:**
1. **NASM required:** near-sdk's `unit-testing` feature pulls in `near-crypto` → `aws-lc-rs` → `aws-lc-sys`, whose Windows build wants the NASM assembler. Fix: set **`AWS_LC_SYS_PREBUILT_NASM=1`**, which uses the pre-built objects shipped in the crate.
2. **ABI step fails to link with MSVC:** `cargo near build` first compiles a native DLL to generate the ABI, and the Microsoft linker can't resolve NEAR host functions (51 unresolved externals). Fix: **`--no-abi`**. ABI metadata is optional. A reproducible ABI build can run on Linux CI later if wanted.
3. **Sandbox integration tests can't run on Windows** (`near-sandbox` has no Windows build). The template's sandbox test dependencies and sample integration test were removed. Integration is tested **on testnet by scripts** after account approval (R1).

**Cost implication for R1:** deploying 143 KB locks about **1.43 testnet NEAR** for storage (1e19 yoctoNEAR per byte). The production contract should shrink, since `serde_json::Value` views inflate the size, but faucet funding must cover deployment plus agent gas and demo payments.

**Still unproven (needs R1 approval):** function-call key behaviour on the real chain (allowed and denied methods, no deposit, revocation), deployment, real transfers and callbacks, and sale-to-payout latency.

## 5. Outstanding requirements

| # | Requirement | Needed for | Owner action | Cost |
|---|---|---|---|---|
| R1 | **Approval to create and fund about 9 testnet accounts** (faucet only) | PoC-B on-chain part: function-call key behaviour, deploy, `pay_order` and payout latency; then M5 | Approve; owner keys go into your NEAR CLI keychain | $0 |
| R2 | **Database choice (D-23)**: Supabase free tier (I check the terms first, then you sign up) **or** local embedded Postgres with no sign-up | PoC-C, then M1 | Choose | $0 |
| R3 | **NEAR AI budget** for integration checks (M2/M4) and the final demo (D-24) | Live AI in the app | Approve a capped amount when M2 is ready | ≈ $0.05 + $0.10 suggested |
| R4 | **Gate 1 approval** of the architecture (docs 00–09) | Start of full development (M1) | Approve | — |
| R5 | Remaining open decisions D-10, D-17, D-18, D-19, D-20, D-21, D-22 ([index](../README.md#decisions-still-open)) | M1–M7 | Review | — |
| R6 | Git identity is set locally (done). A **GitHub remote** only when you decide (Gate 6). | Publishing | Later | $0 |

**Not started (needs your approval):** full application development (M1).
