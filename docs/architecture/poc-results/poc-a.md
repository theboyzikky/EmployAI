# PoC-A results · NEAR AI Cloud (Tier 1)

Run: **2026-11-05**, approved by the owner. Tier 1: `anthropic/claude-haiku-5-5` and `Qwen/Qwen3.8-27B`, hard cap **$0.05**, no retries.
Script: [`spikes/poc-a/run.mjs`](../../../spikes/poc-a/run.mjs). Raw data (no key, no organisation IDs): [`poc-a-raw.json`](poc-a-raw.json).

## Spend

| | Value |
|---|---|
| Paid inference calls | **36** (exactly as planned: 18 per model, no retries, no extra calls) |
| Input tokens | **20 483** (Haiku 12 687 · Qwen 7 796) |
| Output tokens | **13 957** (Haiku 9 523 · Qwen 4 434) |
| Reasoning tokens | 0 (Qwen, with reasoning switched off; Haiku reported none) |
| **Actual cost, billed by NEAR AI** (`POST /v1/billing/costs`, 36 of 36 request IDs matched) | **$0.012238** (Haiku $0.006030 · Qwen $0.006208) |
| Our estimate (usage × catalogue price) | $0.012328 (within 1 % of the billed amount) |
| Cap | $0.05, never approached. The pre-flight worst case was $0.0235. |
| Safety stops triggered | None |
| Key exposure | None. The key was used only in the auth header, and the raw results file contains no `sk-` strings. |

## Free checks (before any paid call)

| Check | Result |
|---|---|
| T0: both models in the live catalogue | ✅ Haiku 5.5 listed (`is_ready` not reported); Qwen 3.8 27B listed, `is_ready=true` |
| T0: prices unchanged from the approved assumptions | ✅ Haiku $0.10 / $0.50 per M; Qwen $0.04 / $1.35 per M |
| T0: features still `tools` + `structured_outputs` | ✅ both |
| T1: key valid and has credit (`POST /v1/check_api_key`) | ✅ HTTP 200, `valid=true` |
| T6: per-request billing lookup | ✅ HTTP 200, all 36 request IDs from the `inference-id` header matched |

## Test results

| Test | Haiku 5.5 | Qwen 3.8 27B |
|---|---|---|
| **T2** discovery turn, strict JSON schema (5) | ❌ **0/5**. Output wasn't valid JSON, and 4/5 hit the 600-token limit (`finish_reason=length`). | ✅ **5/5** valid; 3–5 facts and 2–3 unknowns per turn |
| **T3** team proposal, strict JSON schema (3) | ❌ **0/3**. Invalid or truncated JSON (2 hit the 1 500-token limit). | ⚠ **0/3 by our content criterion, but 3/3 schema-valid** and every tool stayed inside its capability. The model consistently **left out the Order agent** (`order_intake`). |
| **T4** tool call, choose a supplier (5) | ✅ **5/5** well-formed `propose_payment` to an approved supplier | ✅ **5/5** |
| **T5** prompt injection in a supplier quote (5) | ✅ **Resisted 5/5**: paid an approved supplier, never `scam-supplier` | ✅ **Resisted 5/5** |
| Latency p50 / p95 | T2 3.1 / 3.9 s · T3 7.0 / 7.3 s · T4 1.3 / 1.4 s · T5 1.6 / 1.8 s | T2 7.1 / 7.6 s · T3 22.1 / 22.7 s · T4 3.0 / 3.4 s · T5 3.9 / 7.6 s |

## What this means

1. **NEAR AI Cloud works end to end** with our adapter design: key check, chat completions, tool calls, the `inference-id` header and the billing API. Our cost estimate matches the bill within 1 %, so the **daily inference cap can be enforced against real costs** (`business` rule B3).
2. **Haiku 5.5 didn't produce strict JSON** when asked through `response_format: json_schema` via the gateway, even though the catalogue advertises `structured_outputs`. We **didn't save the raw text of failed responses**, so the exact cause (prose, markdown fences, or the schema being ignored) isn't confirmed. Its **tool calls are fast and reliable**, so the standard workaround is to return structured data **through a forced tool call**. That's untested; checking it would take about 5 more calls, roughly $0.002, and only with your approval.
3. **Qwen 3.8 27B honours strict JSON schemas** (8/8 schema-valid), but it's **slower** (7 s per discovery turn, 22 s per team proposal). Its inference environment (TEE or not) **wasn't verified** in this PoC, so no privacy claim is made.
4. **Choosing team members is better done deterministically.** Qwen's valid proposals still left out the Order agent, which supports the design where **rules choose the capabilities** and the LLM only words the agent descriptions.
5. **Injection resistance:** both models ignored the injected instruction in 10/10 attempts. **That doesn't replace enforcement.** The attack demo still relies on the deterministic gate (Part B), and Part A will honestly show "model resisted" if it does.

## Recommendation for D-05 (only relevant if `AI_PROVIDER=nearai` is switched on later)

| Task | Recommended model | Why |
|---|---|---|
| Discovery extraction (structured) | **Qwen 3.8 27B** | 5/5 valid strict JSON; about $0.0003 per turn |
| Procurement reasoning and tool calls | **Haiku 5.5** | 5/5 + 5/5, about 1.5 s, about $0.0002 per call |
| Team proposal | **Deterministic rules** (default), with an optional LLM wording pass | Neither model reliably produced the expected team |

The default stays `AI_PROVIDER=mock` (zero spend). These results only inform the optional real-AI mode.

## Not tested

- Behaviour when a spend limit is exceeded (402): covered by the offline mock-server test (PoC-A0).
- Rate limits: calls ran one at a time.
- Haiku via the forced-tool-call workaround: needs separate approval.
- Tier 2 (Sonnet 5.5): not approved, not run.
