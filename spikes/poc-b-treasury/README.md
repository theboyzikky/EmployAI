# PoC-B · EmployAI treasury contract (spike)

A **throwaway technical spike** from M0. It proves two things:
- the NEAR Rust contract toolchain works on Windows;
- the payment pattern the product relies on works: **agents can only *request* payments, and the contract decides whether they happen.**

This is **not the production treasury contract**, and it has **never been deployed** to any network (testnet or mainnet). The production contract is planned for M5 (see [`docs/architecture/08-milestones.md`](../../docs/architecture/08-milestones.md)).

## What the contract does

| Method | Who may call it | What it enforces |
|---|---|---|
| `new(owner, contributors, split_bps, min_order, max_per_tx, daily_cap)` | Deployer, once | `split_bps` ≤ 10 000 (100 %); `max_per_tx` ≤ `daily_cap` |
| `pay_order(order_id)` (payable) | Anyone (a customer) | Not paused. The attached deposit must be at least `min_order`. The contributors' share (`split_bps` of the deposit) is transferred to the `contributors` account in the same call, and the rest stays in the contract. Emits a `sale` event. |
| `request_payment(request_id, recipient, amount)` | **Only the registered agent** | Not paused. The caller is the registered agent. The recipient is on the approved list. `0 < amount ≤ max_per_tx`. `request_id` has never been used. Today's total stays within `daily_cap` (the counter resets each UTC day). Then it transfers to the recipient and emits `payout_requested`. |
| `on_payout(…)` | The contract itself (`#[private]` callback) | Emits `payout_completed`, or on a failed transfer `payout_failed`, and gives the amount back to today's allowance |
| `set_agent(agent \| null)` | **Owner only** | Registers or **revokes** the paying agent |
| `approve_recipient(account)` | **Owner only** | Adds an account to the approved-recipient list |
| `pause()` / `unpause()` | **Owner only** | Stops or resumes `pay_order` and `request_payment` (emits `paused` / `unpaused`) |
| `get_policy()`, `is_approved(account)`, `is_processed(request_id)` | Anyone (views) | Read the current policy, approval and request status |

Events are logged as `EVENT_JSON` with `standard: "employai-treasury"`, version `0.1.0`.

### Restricted payment permissions (the security idea)

- **The agent can't move money directly.** Its only payment path is `request_payment`, and the contract checks every rule in the table above before anything is transferred.
- **The agent can't change the rules.** Only the owner can register or revoke the agent, approve recipients, or pause and unpause, and every owner method checks the caller.
- **Approved recipients only.** A payment to an account the owner hasn't approved is rejected, even when the registered agent asks for it.
- **Limits on-chain:** a per-transaction maximum and a daily cap, enforced by the contract and independent of any off-chain checks.
- **Replay protection:** each `request_id` can be used once.
- **Kill switch:** `pause()` stops both payment methods.
- **Planned, not yet tested:** in the product, the Finance Agent will call `request_payment` with a NEAR **function-call access key** limited to this contract and that one method, with no attached deposit. This key restriction is a property of the NEAR account, not of this contract code, and it has **not** been tested here. It needs testnet accounts, which haven't been created; see "Not yet proven" below.

## Tests

`cargo test --lib`: **12 unit tests pass**. Last run 2026-11-06, Rust 1.93.0, `near-sdk` 5.29.1.

| Test | Proves |
|---|---|
| `sale_splits_revenue_and_logs_event` | A 1 NEAR sale sends 10 % to contributors and logs the `sale` event |
| `sale_below_minimum_rejected` | A sale below `min_order` is rejected |
| `agent_pays_approved_recipient_within_limits` | The agent can pay an approved recipient within the limits |
| `other_caller_rejected` | Any other caller is rejected |
| `unapproved_recipient_rejected_even_for_agent` | An unapproved recipient is rejected, even for the agent |
| `over_per_tx_rejected` | An amount above `max_per_tx` is rejected |
| `daily_cap_enforced` · `daily_cap_resets_next_day` | The daily cap holds and resets the next day |
| `duplicate_request_rejected` | A repeated `request_id` is rejected |
| `pause_blocks_agent` | Pausing blocks `request_payment` |
| `agent_cannot_unpause_or_change_policy` | The agent can't call owner methods |
| `revoked_agent_rejected` | After `set_agent(null)`, the old agent is rejected |

These are unit tests with a mocked NEAR environment (`VMContextBuilder`). They check the contract's decisions. They don't execute real transfers or callbacks.

## Not yet proven, or not implemented

- **Never deployed;** no on-chain behaviour has been observed. That needs the testnet accounts in requirement R1 of the [M0 report](../../docs/architecture/poc-results/m0-report.md), which haven't been created or funded.
- **Function-call key behaviour** on a real chain: allowed and denied methods, no deposit, revocation. Not tested.
- **Real transfers and the `on_payout` callback:** the failed-transfer rollback has no unit test, because it needs a real or sandboxed promise result. Sandbox integration tests were removed because `near-sandbox` has no Windows build (see `Cargo.toml`).
- **No owner withdrawal, recipient removal or policy-update method.** The planned `set_policy`, and changing limits after initialisation, are not in this spike. Revenue left after the contributors' share stays in the contract.
- **A `request_id` stays used even if its transfer fails,** so a failed payout must be retried with a new ID.
- **`pay_order` while paused** is rejected by the code but has no unit test.
- **Build warning:** `env::promise_result` is deprecated in `near-sdk` 5.29.1 (the replacement is `promise_result_checked`). It is left as is in this spike.

## Build and test (Windows, as used in M0)

```bash
# Unit tests. Use pre-built NASM objects so no assembler install is needed.
AWS_LC_SYS_PREBUILT_NASM=1 cargo test --lib

# WebAssembly build. --no-abi skips the ABI step, which fails to link with MSVC on Windows.
cargo near build non-reproducible-wasm --no-abi
```

The M0 build produced `poc_b_treasury.wasm`, 143 002 bytes. Deploying a contract of that size would lock about 1.43 testnet NEAR for storage. `rust-toolchain.toml` pins Rust 1.93.0 with the `wasm32-unknown-unknown` target.

This spike was scaffolded with `cargo near new`. The template's sample auction contract was replaced with this treasury, and its sandbox integration tests were removed (see above).
