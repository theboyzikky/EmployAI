# EmployAI treasury contract v1 (M5 Phase 1)

The policy-enforcing treasury for EmployAI's supplier payouts on NEAR **testnet**. Built from the M0 spike (`spikes/poc-b-treasury`) to the [M5 plan v3.1](../../docs/architecture/m5-proposal.md), changes C1–C6 and C8–C12 (no C7 guardian).

**Status:** implemented and tested offline on 2026-11-09. **Not deployed:** no account, transaction or network deployment exists. Everything on-chain below is still to be proven in later, separately approved batches.

## What it enforces
| Area | Behaviour |
|---|---|
| **Who can pay** | Only the registered agent can call `request_payment`, and it can't attach a deposit. Owner methods (`set_agent`, `set_policy`, `approve_recipient`, `remove_recipient`, `pause`, `unpause`, `withdraw`, `set_sales`) require the owner **and exactly 1 yoctoNEAR**, so a function-call key can't call them. |
| **To whom** | Only accounts on the on-chain allowlist. |
| **How much** | `0 < amount ≤ max_per_tx`; the day's total (Pending + Paid) ≤ `daily_cap`; and the amount must leave the storage requirement plus a 1,000-byte reserve. |
| **Once** | Each request ID (8–64 characters `[A-Za-z0-9:_-]`) goes absent → Pending → Paid or Failed. Pending and Paid can never be requested again. **Failed can be retried only with the same recipient and amount.** At most one successful payout per request ID. |
| **Asynchronous settlement** | `request_payment` records Pending, adds to the day's total, and creates the transfer plus a **private** `on_payout` callback (10 Tgas). The callback reads the result with `promise_result_checked` and calls the internal `settle`. Success → Paid. Failure → Failed, and **the day's total is rolled back only if the counter is still on the request's own UTC day.** An unrecognised promise result panics, so the request stays Pending and is never wrongly marked. |
| **Records** | Never deleted. `get_request` returns `null` or the full record (recipient, amount, day, status, agent, `requested_at_block`, `settled_at_block`, attempts). It is the durable source of payment status. |
| **Pause** | Blocks `request_payment` (and `pay_order`). Owner-only. |
| **Init** | `#[init] #[private]` plus an in-body check: only the contract account itself can initialise. Deploy and initialise in one transaction. |
| **Withdraw** | To the owner only, never below storage plus the reserve. |
| **Customer sales** | `pay_order` exists but is **disabled at initialisation** (`sales_enabled = false`, checked first), and unused by the app in M5. When enabled, the contributors' share is sent with its own callback and event. |
| **Events** | NEP-297, `employai-treasury` 1.0.0, for every state change: `initialised`, `agent_set`, `policy_set`, `recipient_approved`, `recipient_removed`, `paused`, `unpaused`, `withdrawn`, `sales_config_set`, `payout_requested`, `payout_completed`, `payout_failed` (with `rolled_back`), `sale_received`, `contributors_share_completed`, `contributors_share_failed`. |
| **Views** | `get_policy`, `get_request`, `is_approved`, `get_spent_today`, `get_sales_config` |

## Tests (offline, 2026-11-09)

```bash
AWS_LC_SYS_PREBUILT_NASM=1 cargo test --lib --offline
```

**Result: 50 passed, 0 failed.** The plan's asynchronous tests:

| Plan test | Unit test |
|---|---|
| T-A1 | `t_a1_every_rejected_request_leaves_no_record_and_no_spend` (12 rejection cases) |
| T-A2 | `t_a2_success_marks_paid_and_keeps_the_spend` |
| T-A3 | `t_a3_failure_same_day_marks_failed_and_rolls_back_exactly` |
| T-A4 | `t_a4_failure_after_midnight_does_not_touch_the_new_days_total` |
| T-A5 | `t_a5_failure_settled_next_day_before_any_new_request_rolls_back_day_d` |
| T-A6 | `t_a6_pending_and_paid_requests_can_never_be_requested_again` |
| T-A7 | `t_a7_retry_only_after_failure_with_identical_details_and_never_twice_paid` |
| T-A8 | `t_a8_callbacks_reject_external_callers` |
| T-A9 | `t_a9_unknown_or_already_settled_requests_cannot_be_settled` |
| T-A10 | `t_a10_pending_requests_count_and_a_same_day_failure_frees_its_amount` |
| T-A11 | `t_a11_on_payout_reads_the_mocked_promise_result` |
| T-A12 | `t_a12_payout_event_payloads_match_the_schema_exactly` |
| T-A13 | `t_a13_records_are_durable_and_complete` |

**The other 37 tests cover:**
- private init and limit validation;
- owner-only and exactly-1-yocto checks on every owner method;
- policy, agent and recipient changes;
- pause and unpause;
- the withdraw storage floor at its exact boundary;
- request-ID bounds;
- retry day, cap and allowlist rules;
- receipt structure: a transfer, then an `on_payout` callback with 10 Tgas and no deposit; no receipts on rejection;
- `pay_order` refused while disabled (even when paused), plus its minimum, pause, share rounding and callback outcomes;
- event payloads.

**What these tests don't prove:**
- they use near-sdk's mocked environment, which doesn't run real transfers, protocol refunds or gas metering;
- the **rollback logic** is proven here; **refunds and real callback behaviour** are claimed only after testnet evidence (plan S8, batch B4);
- the generated WASM entry-point checks (`#[private]`, non-payable) aren't exercised directly, which is why the same checks are repeated inside the methods, where the tests cover them.

## Build (offline, 2026-11-09)

```bash
CARGO_NET_OFFLINE=true AWS_LC_SYS_PREBUILT_NASM=1 cargo near build non-reproducible-wasm --no-abi
```

| | |
|---|---|
| WASM | `target/near/employai_treasury.wasm` (not committed; rebuilt from source) |
| Size | **174,359 bytes** (≈ 1.74 testnet NEAR of storage at 1e19 yocto per byte, the B0 figure) |
| SHA-256 (hex) | **`fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad`** (confirmed with `sha256sum`) |
| SHA-256 (base58, the format of the on-chain `code_hash`) | **`HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt`** |
| Toolchain | Rust 1.93.0 (`rust-toolchain.toml`), cargo-near 0.22.0, `near-sdk` 5.29.1 (same lockfile as the M0 spike; no new crates) |

The build is **non-reproducible**, the Windows workaround from M0: another machine may produce different bytes. The B1 code-hash check compares the deployed `code_hash` with the base58 hash above.

## Warnings
- **WASM build** (`cargo build --release --target wasm32-unknown-unknown --offline`): **0 warnings.**
- **Clippy on the library:** 0 warnings.
- **Test build: 1 warning.** It's the deprecated near-sdk test helper `testing_env_with_promise_results`, used in one place, `tests.rs` (`with_promise_result`).
  - **Why it's not fixed:** the replacement near-sdk recommends, `testing_env!` with five arguments, needs `near_parameters::RuntimeFeesConfig`. near-sdk 5.29.1 doesn't re-export it, so the fix would need `near-parameters` as a direct dev-dependency, which Phase 1 doesn't allow.
  - **Status:** left visible, not suppressed. It affects tests only, never the WASM.
- **cargo-near update check:** cargo-near printed "new update available 0.22.0 → 0.23.0". Its own update check appears to have contacted the network, even though cargo ran offline. It didn't affect the build.
