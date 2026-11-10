# M5 batch log

Every M5 interaction with NEAR testnet, recorded against the batch the owner approved. A transaction hash appears here only if an RPC response returned it.

| Batch | Approved | Scope | Status |
|---|---|---|---|
| **B0** | Owner, 2026-11-08 ("I approve M5 Phase 0 only… you may run B0 read-only public RPC checks and record the results") | Read-only public RPC checks | **Done 2026-11-07T23:53Z (main run) and 2026-11-09T12:47Z (two follow-ups). Findings B0-1 to B0-8 approved in principle (2026-11-09) and applied to the plan.** |
| B1 | Owner, 2026-11-09 | Provisioning and deployment | **PASS: executed by the owner 2026-11-09; results below** |
| B2 | Owner, 2026-11-09 | Restricted-key proof and negative tests | **PASS: executed by the owner 2026-11-09; results below** |
| B3 | — | Demo payments | Not approved |
| B4 | — | Kill switch, failure, revocation, crash | Not approved |
| E | Standing pre-authorisation (O3) | Owner's emergency pause and key revocation | Not used |

## B0 · Read-only public RPC checks

**What ran:** three Node scripts from the session scratchpad. They are not part of the app, and nothing was added to the repository.
- **No keys and no signing.** No `send_tx` or broadcast: the main script refuses those methods. No account creation, funding or deployment.
- **No dependencies installed, and no `.env` access.**
- **Endpoints:**
  - `https://test.rpc.fastnear.com`: primary, the doc 06 default;
  - `https://rpc.testnet.near.org`: fallback, two calls;
  - one page GET to `https://testnet.nearblocks.io/txns/<hash>` (explorer link format).
- **Requests:** 18 JSON-RPC reads plus 1 explorer GET.
- **Methods:** `status`, `query` (`view_account`, `view_access_key_list`, `view_access_key`), `EXPERIMENTAL_protocol_config`, `gas_price`, `block`, `chunk`, `tx` (status read).

### Results
| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Network and providers | Both endpoints answer: `chain_id: "testnet"`, protocol version **88**, not syncing (block 276,699,669 at the main run) | `status` |
| 2 | **Parent name `employai-demo.testnet`** | **Free** at block 276,699,674: `UNKNOWN_ACCOUNT` ("does not exist while viewing"). Nothing was created, so someone else could still register it before B1. | `view_account` |
| 3 | `view_account` response shape | `amount` (string, yocto), `locked` (string), `code_hash` (base58), `storage_usage`, `storage_paid_at`, `block_hash`, `block_height` | `view_account` on `testnet` |
| 4 | `view_access_key_list` on a large account | **Error `TOO_MANY_ACCESS_KEYS`** (more than 100 keys; "use a paginated request") | `testnet` |
| 5 | `view_access_key`, key **missing** | **Not a JSON-RPC error:** HTTP 200 with `result.error` = "access key … does not exist while viewing" and `logs: []` | `view_access_key` on `testnet` |
| 6 | `view_access_key`, key **present** | `result` has `nonce`, `permission`, `block_hash`, `block_height`. A full-access key reads `"permission": "FullAccess"` (a string). **A live FunctionCall permission was not observed in B0.** | A fresh transaction's signer, block 276,922,059 |
| 7 | Storage cost | `storage_amount_per_byte` = **1e19 yoctoNEAR** (confirms the 1.43 NEAR estimate per 143 KB) | `EXPERIMENTAL_protocol_config` |
| 8 | Transaction validity window | `transaction_validity_period` = **86,400 blocks**; `epoch_length` = 43,200 | same |
| 9 | Gas price | **1e8 yoctoNEAR per gas**: 100 Tgas fully burnt = **0.01 NEAR** | `gas_price` |
| 10 | Transaction status shape | `tx` with `wait_until: "FINAL"` on a final transaction: top-level `final_execution_status` ("FINAL"), `status` (`SuccessValue`), `transaction`, `transaction_outcome`, `receipts_outcome[]`. Each receipt outcome has `executor_id`, `status`, `logs[]`, `gas_burnt`, `tokens_burnt`, `receipt_ids`, `metadata.gas_profile`. | One public FunctionCall transaction (`ds86Eu…ULJa`, by another party, unrelated to EmployAI) |
| 11 | Unknown transaction | Error `UNKNOWN_TRANSACTION` ("Transaction … doesn't exist") | `tx` with a dummy hash |
| 12 | **Transaction retention** | The sample transaction (about 37 h old at the follow-up) returned **`UNKNOWN_TRANSACTION` from both public endpoints**. These nodes don't keep older transactions. | `tx`, both endpoints |
| 13 | Explorer link `https://testnet.nearblocks.io/txns/<hash>` | **HTTP 403** to the script (bot protection). The response body contained the hash, but the format is **not confirmed**. | One GET |

### Findings B0-1 to B0-8: approved in principle by the owner (2026-11-09) and applied to the [M5 plan v3.1](../m5-proposal.md)

| # | Finding | Evidence (B0) | Implementation consequence | Plan |
|---|---|---|---|---|
| **B0-1** | A **missing access key** is reported **inside a successful response**, not as an RPC error | Check 5: HTTP 200, `result.error` = "access key ed25519:1111… does not exist while viewing", `logs: []` | The key verifier treats `result.error` as **key missing → `SIGNER_KEY_UNSAFE`**, never as success. A unit test uses this exact response shape. | §5.3, AC5-3 |
| **B0-2** | Listing keys can fail with **`TOO_MANY_ACCESS_KEYS`** | Check 4: `view_access_key_list` on `testnet` → error ("more than 100 access keys") | The app **never lists keys**; it reads only its own configured key. Any RPC or parse error means "unverified", so it **refuses to sign** (fail closed). | §5.3 |
| **B0-3** | **A live FunctionCall permission wasn't observed;** only `"permission": "FullAccess"` (a string) on an unrelated account | Check 6 (block 276,922,059); the result keys were `nonce`, `permission`, `block_hash`, `block_height` | **The verifier stays strict:** it accepts only `{FunctionCall: {receiver_id: treasury, method_names: ["request_payment"], allowance: null}}`; **`FullAccess` is never accepted**. **B2 must capture the exact response for the EmployAI-controlled `finance-agent` key**, stored as the verifier's test fixture, before the app relies on it. Until then, testnet mode stays unavailable (`SIGNER_KEY_UNCONFIRMED`). | §5.3, §21 (Phases 2–3), AC5-3 |
| **B0-4** | **Public nodes prune transactions:** a transaction about 37 h old returned `UNKNOWN_TRANSACTION` from both endpoints | Check 12: `ds86Eu…ULJa`, final at about 2026-11-07T23:53Z, unknown at 2026-11-09T12:47Z on FastNEAR and `rpc.testnet.near.org` | **The contract's request record (`get_request`) is the primary source of payment status.** Transaction lookups are secondary and time-limited. **`UNKNOWN_TRANSACTION` is never proof of non-execution.** A **Pending** request is never submitted again. The verified outcome is stored as soon as it's final. A **new signed transaction** only when all three conditions hold: (1) the original's validity window has expired by block height; (2) the latest final contract state has no record of the request; (3) identical details, same request ID, a fresh gate evaluation and a fresh owner approval. Request records are never deleted (C2). | §10, §11, §11.1, §12, C2, C10, T-A13, AC5-22 |
| **B0-5** | **Gas price 1e8 yoctoNEAR per gas** | Check 9 (`gas_price`, block about 276.7 M) | **A worst-case estimate of ≈ 0.01 NEAR per payment:** 100 Tgas prepaid (1e14 gas) × 1e8 yocto/gas = 1e22 yocto. **Not a guaranteed or expected cost:** unused gas is refunded, and the price can change. Actual gas is **measured** in B2 and B3 and reported separately. The 0.5 NEAR agent budget covers at least 50 payments at the worst case. | §5.2, AC5-17 |
| **B0-6** | **Transaction validity window: 86,400 blocks** (epoch 43,200) | Check 8 (`EXPERIMENTAL_protocol_config`) | Resubmission is judged by **block height**, never wall-clock time. The window is read at signing and stored with the attempt (`signed_block_height`, `validity_period_blocks`, `expires_after_height`). | §11.1 |
| **B0-7** | **The explorer page returns HTTP 403 to scripts** | Check 13: a GET to `https://testnet.nearblocks.io/txns/<hash>` → 403 (the body contained the hash) | Explorer links are shown as **"Explorer link (format unverified)"** until the owner confirms one manually in a browser (planned during B3; recorded here). The ledger's proof is the hash plus the stored outcome, never the link. | §12, §17 |
| **B0-8** | **The parent name `employai-demo.testnet` was free, but isn't reserved** | Check 2: `UNKNOWN_ACCOUNT` at block 276,699,674 (2026-11-07T23:53Z) | **Time-sensitive.** B1 starts with a read-only re-check. If the name is taken, the B1 sheet proposes an alternative for the owner's approval. Nothing is created until B1 is approved. | §5.1, §21 (Phase 2) |

### Other B0 confirmations used by the plan
- Storage costs 1e19 yocto per byte (check 7).
- Transaction status responses: `final_execution_status`, `status`, `transaction`, `transaction_outcome`, and `receipts_outcome[]` with `executor_id`, `status`, `logs`, `gas_burnt`, `tokens_burnt` (check 10). This is enough to verify the four conditions in plan §12 while the transaction is still held.
- An unknown transaction returns `UNKNOWN_TRANSACTION` (check 11).
- Both public endpoints answer (check 1).

### Not done in B0 (by design)
- No transaction, signature, account, funding, deployment or dependency.
- No access to `.env`.
- No change to app code.

## B1 · Provisioning and deployment: batch sheet (prepared 2026-11-09; later approved and executed: see B1 · Results)

**Run by:** the owner, in Git Bash at the repository root, with near-cli-rs signing from the owner's OS keychain. Nothing here is ever run by EmployAI or Claude. **Scripts:** [`scripts/m5/`](../../../scripts/m5/). They do a dry run unless given `--execute`, and each transaction asks for `YES`.

### Transactions (9)
| # | Transaction | Signed by | NEAR moved | Gas (prepaid) |
|---|---|---|---|---|
| 1 | Create `employai-demo.testnet` (faucet-sponsored) | Faucet service | Faucet funding (amount unknown) | — |
| 2 | Create `treasury.employai-demo.testnet` | Parent | 2.5 NEAR parent → treasury | default |
| 3 | Create `finance-agent.employai-demo.testnet` | Parent | 0.5 NEAR parent → agent | default |
| 4 | Create `supplier-1.employai-demo.testnet` | Parent | 0.1 NEAR | default |
| 5 | Create `supplier-2.employai-demo.testnet` | Parent | 0.1 NEAR | default |
| 6 | **Deploy and init in one transaction:** `new(owner = parent, agent = finance-agent, max_per_tx = 0.1 NEAR, daily_cap = 0.25 NEAR)`, with sales disabled | Treasury (its own key) | 0 (≈ 1.75 NEAR becomes storage-locked) | 100 Tgas |
| 7 | `approve_recipient(supplier-1)` | Parent (owner) | 1 yoctoNEAR | 30 Tgas |
| 8 | `approve_recipient(supplier-2)` | Parent (owner) | 1 yoctoNEAR | 30 Tgas |
| 9 | Add the restricted key to `finance-agent`: receiver `treasury`, method `request_payment`, allowance unlimited (null); saved to the legacy keychain file | Agent (full-access key) | 0 | default |

**Totals:**
- **NEAR moved:** 3.2 NEAR, only between the owner's own accounts, plus 2 yoctoNEAR.
- **Gas:** worst case ≈ 0.01 NEAR per 100 Tgas transaction (B0-5). Actual gas is recorded.
- **Nothing goes to a third party.**

**Not in B1:**
- the never-created test recipient (for S8; that's B4);
- any payout;
- pause or unpause;
- any `.env` change.

### Required balances
| Account | Needs | Why |
|---|---|---|
| Parent (after the faucet) | **≥ 3.6 NEAR**; the script stops below this | Funds 3.2 NEAR of sub-accounts plus gas |
| Treasury | 2.5 NEAR | ≈ 1.75 NEAR storage for the 174,359-byte WASM (1e19 yocto per byte) plus state, leaving ≈ 0.7 NEAR payout float |
| Finance Agent | 0.5 NEAR | Gas only (≥ 50 payments at the 0.01 NEAR worst case) |
| Suppliers | 0.1 NEAR each | Existence |

### Exact commands (Git Bash, repository root)
```bash
bash scripts/m5/00-precheck.sh
bash scripts/m5/01-provision.sh
bash scripts/m5/01-provision.sh --execute
bash scripts/m5/02-verify.sh
```
1. `00-precheck.sh`: read-only. Checks the tools, the **WASM SHA-256 (`fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad`) and size (174,359 bytes)**, and that the 5 names are still free.
2. `01-provision.sh`: a dry run. It prints all 9 commands without signing and makes no network calls.
3. `01-provision.sh --execute`: re-checks the WASM hash, then runs the 9 transactions, asking for `YES` before each.
4. `02-verify.sh`: read-only. Checks the code hash, the initial state, the allowlist and the agent's keys, and saves evidence JSON.

### Expected outputs
| Step | Expected |
|---|---|
| Precheck | Tools found; "WASM matches the reviewed artifact"; "All five names are free right now" |
| Faucet creation | near-cli reports the account created and the key saved to the keychain |
| Parent balance check | "parent balance: N NEAR (need at least 3.6)", then "OK" |
| Each later transaction | near-cli prints a transaction ID and a success status |
| Verify | `code_hash = HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt`; owner and agent correct; limits `100000000000000000000000` and `250000000000000000000000`; `paused = false`; `sales_enabled = false`; spent `0`; both suppliers approved and the parent **not**; agent keys: 1 function-call key and 1 full-access key; "B1 verified" |

### Recovery
| # | Situation | Action |
|---|---|---|
| R-B1-1 | **A name is already taken** and it isn't yours | Stop. Nothing is created. I'll propose new names (the scripts take `PARENT=…` etc.) for re-approval. |
| R-B1-2 | The faucet fails or is rate-limited | Stop and retry later. **No paid funding.** |
| R-B1-3 | Parent has < 3.6 NEAR | The script stops before any sub-account. Report the balance; options (wait, or smaller balances) need approval. |
| R-B1-4 | **Interrupted part-way** | Re-run `--execute`. Existing accounts are skipped. The deploy is skipped if the reviewed code is already there and **refused if different code is there**. Re-approving a supplier is harmless. The key step is skipped if a restricted key exists. |
| R-B1-5 | **Deploy and init fails** | Deploy and init are one transaction, so a failed init leaves **no code**. Check it with `02-verify.sh` (`code_hash` all 1s), then re-run. |
| R-B1-6 | **Deployed `code_hash` ≠ `HvewF…`** | **Stop.** Don't approve recipients or add keys. No in-place fix (R6): a fresh treasury account needs a new approved batch. |
| R-B1-7 | The CLI rejects `--allowance unlimited` or `save-to-legacy-keychain` | **Stop and report.** Don't substitute a numeric allowance or a different storage method (the verifier accepts only a null allowance). |
| R-B1-8 | `02-verify.sh` reports a wrong key permission | Delete that key with `near account delete-keys <agent> public-keys <key> network-config testnet sign-with-keychain send`, then re-add after approval. |
| R-B1-9 | A keychain entry is lost | That testnet account can't be recovered; fresh accounts and re-approval. |

**After B1 (owner only):**
- Copy the restricted key's private key from its legacy-keychain file (`~/.near-credentials/testnet/finance-agent.employai-demo.testnet…`) into **your** `.env` as `NEAR_FINANCE_AGENT_PRIVATE_KEY`, with `NEAR_FINANCE_AGENT_ACCOUNT_ID`.
- Only the app needs this, in Phase 3 or later. **Never paste it into chat.**

## B2 · Restricted-key proof and negative tests: batch sheet (prepared 2026-11-09; later approved and executed: see B2 · Results)

### Part 1 · Restricted-key proof (read-only)
```bash
bash scripts/m5/03-b2-key-check.sh
```
- **What it does:** saves the exact `view_access_key` response for the agent's restricted key (the fixture for Phase 3) and checks it strictly.
- **Passes only for:** `FunctionCall{receiver_id: treasury, method_names: ["request_payment"], allowance: null}`.
- **Fails for:**
  - `FullAccess`;
  - a missing key, including when it's reported inside `result.error` (B0-1);
  - any other receiver, methods or allowance;
  - an RPC error.

  These failure cases were tested offline against B0-shaped data (8 cases).
- **It also locates the legacy-keychain file holding the key,** without printing it.

### Part 2 · Negative tests (12 transactions, **every one must fail**)
```bash
bash scripts/m5/04-b2-negative-tests.sh
bash scripts/m5/04-b2-negative-tests.sh --execute
```
The first command is a dry run. The second runs the tests, asking for `YES` before each.

| # | Attempt | Signed with | Expected failure |
|---|---|---|---|
| K1 | `set_policy` | Restricted key (key file) | Rejected by the network: method not allowed (`MethodNameMismatch`) |
| K2 | `pause` | Restricted key | `MethodNameMismatch` |
| K3 | `approve_recipient(parent)` | Restricted key | `MethodNameMismatch` |
| K4 | `request_payment` with 1 yoctoNEAR attached | Restricted key | Function-call keys can't attach deposits (`DepositWithFunctionCall`) |
| K5 | A call to another account (the parent) | Restricted key | `ReceiverMismatch` |
| K6 | A plain 0.01 NEAR transfer to the parent | Restricted key | `RequiresFullAccess` |
| K7 | Adding the parent's own public key as a full-access key | Restricted key | `RequiresFullAccess` |
| C1 | `request_payment` to the parent (not allowlisted) | Restricted key | Contract panic: "Recipient not approved" |
| C2 | `request_payment` 0.11 NEAR (over 0.1) | Restricted key | "Amount over per-transaction limit" |
| C3 | `request_payment` with request ID `bad` | Restricted key | "Invalid request_id" |
| C4 | `request_payment` signed by the owner (not the agent) | Owner keychain | "Not the registered agent" |
| C5 | `pay_order` with 0.01 NEAR while sales are disabled | Owner keychain | "Sales disabled" (deposit refunded) |

- **Cost:**
  - K1–K7 should be rejected before execution, with no fee;
  - C1–C5 are included and burn gas, at most ≈ 0.01 NEAR each (worst case), from the agent or the parent.
- **Exposure if a test unexpectedly succeeded:**
  - every possible money flow goes only to owner-controlled accounts (parent, supplier-1, treasury), ≤ 0.15 NEAR in total;
  - K7 would only add the parent's own key;
  - the script **stops immediately** on any unexpected success.
- **Afterwards (read-only):**
  - no request records for any test ID;
  - spent today = 0;
  - policy unchanged;
  - the parent is still not allowlisted;
  - the agent still has exactly 2 keys.
- **Gas evidence:** the C-step logs hold the transaction IDs, and gas burnt is recorded here. Callback gas isn't measured in B2, because every C step panics before a callback; it's measured at the first real payout (B3).

### Recovery
| # | Situation | Action |
|---|---|---|
| R-B2-1 | `03` can't find the key file | Check `~/.near-credentials/testnet/` for the agent. If the CLI saved the key elsewhere, stop and report. **Don't paste the private key into any command.** |
| R-B2-2 | near-cli refuses a K test **locally** (an error before sending, not a network error) | Mark it "not chain-proven" and report. An alternative proof is the `display` plus `send-signed-transaction` route, which needs approval. |
| R-B2-3 | **Any test unexpectedly succeeds** | The script stops. Run the pre-authorised emergency procedure if needed (`bash scripts/m5/emergency.sh revoke-agent-key --execute` and/or `pause --execute`), record it as batch E, and report. |
| R-B2-4 | A test fails with an unexpected error | The script marks it REVIEW and continues; it's analysed before B3. |

## Tooling note: cargo-near's update check (investigated 2026-11-09, without network)
- **What was found:** cargo-near 0.22.0 has **no setting to disable its update check**. The binary contains only `CARGO_NEAR_*` build variables. The check uses the `self_update` crate against `api.github.com …/releases/latest`. The binary also contains what look like telemetry field names (`api_key`, `event`, `distinct_id`); whether they're sent wasn't determined.
- **Proposed for the next approved build (untested):** set `HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9` for that one command, with `CARGO_NET_OFFLINE=true`. Any outbound request would then fail on this machine, and `self_update` uses reqwest, which honours these variables. Whether the build still succeeds with the check failing will be confirmed on that run. No rebuild has been done.
- **near-cli-rs** needs the network for every B1 and B2 step anyway. Whether it also checks for updates or sends telemetry wasn't determined.

## B1 pre-execution review (2026-11-09; written before approval)

### Precheck (`00-precheck.sh`, owner-approved, run 2026-11-09)
- **Tools:** near, curl, node and sha256sum all found.
- **WASM:** sha256 `fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad` and 174,359 bytes, matching the reviewed artifact.
- **Names:** all five free at the time of the check (5 read-only RPC reads); not reserved.

### near-cli-rs 0.30.1: command verification from local help output
**Method:** `near … --help` at every level of every command, with all proxy variables pointed at a closed local port (`127.0.0.1:9`), so no request could leave the machine. Argument parsers were checked with deliberately invalid values. The version string in the binary is `0.30.1`.

| Command (scripts) | Verified | Finding |
|---|---|---|
| `account create-account sponsor-by-faucet-service <id> autogenerate-new-keypair save-to-keychain network-config testnet create` | Every level | OK |
| `account create-account fund-myself <id> '<n> NEAR' autogenerate-new-keypair save-to-keychain sign-as <signer> network-config testnet sign-with-keychain send` | Every level; amount parser rejects `abc` | OK |
| `contract deploy <id> use-file <wasm> with-init-call new json-args '<json>' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send` | Every level | OK. Deploy and init are built as **one transaction** ("with-init-call: Add an initialize"); confirm from the single transaction ID in the B1 log. |
| `contract call-function as-transaction <c> <m> json-args '<json>' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <s> network-config testnet sign-with-keychain send` | Every level; gas parser rejects `bogus` | OK |
| `… call-function as-transaction <c> <m> empty-args …` | **Invalid in 0.30.1:** "invalid value 'empty-args' … possible values: json-args, text-args, base64-args, file-args" | **Fixed:** replaced with `json-args '{}'` (B2 K2 and K5, `emergency.sh` pause and unpause; not used in B1) |
| `account add-key <id> grant-function-call-access --allowance unlimited --contract-account-id <c> --function-names request_payment autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send` | Every level; `--allowance bogus-value` is **rejected** ("invalid token unit"), `unlimited` is **accepted** | OK. That `unlimited` is stored as a null allowance on-chain is proven by B2 part 1. |
| `… sign-with-access-key-file <file> send` | Every level | OK (B2) |
| `tokens <a> send-near <b> '0.01 NEAR' network-config testnet …` | OK | (B2) |
| `account add-key <a> grant-full-access use-manually-provided-public-key <pk> …` / `account delete-keys <a> public-keys <pk> …` | OK | (B2, emergency) |

**Not verifiable from help:** whether near-cli saves the new key to the keychain **before or after** it sends the account-creation transaction. If it sent first and then failed to save, that one testnet account would be unusable (recovery R-B1-9: new names and re-approval). The treasury's safety isn't affected.

### near-cli-rs update check and telemetry (investigated offline)
- **Update check:** present. The binary contains the `self_update` crate (1.0.0-rc.6), the GitHub releases API path (`api.github.com/repos/…/releases`) and "`near` CLI has a new update available".
  - **What it sends:** an HTTPS GET to GitHub. That reveals your IP address, the time, and a user agent naming the update library.
  - **What it doesn't send:** no account, key or command data was found to be part of that request. This is inferred from the binary, not observed on the wire.
  - **Whether it ran in our checks:** with all traffic blocked, `near --version` and every `--help` call still worked normally, so a failed check doesn't break the CLI.
- **Telemetry:** no telemetry library or endpoint found. No PostHog, Segment, Mixpanel, Amplitude or Sentry markers. The `api_key` strings belong to optional RPC-provider API keys in the config. **This is no evidence of telemetry, not proof of its absence.**
- **Hosts compiled into the binary:** RPC providers (FastNEAR, Lava), the testnet faucet helper (`helper.nearprotocol.com`), NearBlocks and FastNEAR APIs, CoinGecko (prices), wallet and explorer URLs, and GitHub. B1 needs only the testnet RPC and the faucet.
- **No setting disables the update check.** Neither the binary's environment variables nor the config file has one.
- **Opt-in mitigation added (off by default):** `M5_RESTRICT_NEAR_CLI_NETWORK=1` lets near-cli reach only `archival-rpc.testnet.fastnear.com` (the `testnet` RPC in your config) and `helper.nearprotocol.com`; everything else, including GitHub, fails locally. It's **untested for signing commands**. If the RPC were blocked, near-cli would fail **before** sending, which is safe.
- **Side effect to note:** the first local `near` call migrated your near-cli `config.toml` from version 4 to 5. Its network names, RPC URLs and faucet URLs are unchanged; no backup was made. Any first run of near-cli 0.30.1 would have done the same.

### Exact B1 transaction sequence

**The order is chosen so the agent can't pay anything until everything else is in place.** The policy is set at init, the allowlist comes next, and the restricted key comes **last**. Until step 9, the agent has no key the app could use.

| # | Transaction | Signer | Actions | NEAR moved | Prepaid gas |
|---|---|---|---|---|---|
| 1 | Create `employai-demo.testnet` | Faucet helper | Faucet creates the account with your new public key | Faucet amount F (unknown) | — |
| 2 | Create `treasury.employai-demo.testnet` | Parent | CreateAccount, Transfer 2.5 NEAR, AddKey (full access, your keychain) | 2.5 | CLI default |
| 3 | Create `finance-agent.employai-demo.testnet` | Parent | Same pattern; full-access **recovery** key in your keychain | 0.5 | CLI default |
| 4 | Create `supplier-1.employai-demo.testnet` | Parent | Same pattern | 0.1 | CLI default |
| 5 | Create `supplier-2.employai-demo.testnet` | Parent | Same pattern | 0.1 | CLI default |
| 6 | Deploy and init | Treasury | DeployContract (the reviewed WASM) + FunctionCall `new{owner: employai-demo.testnet, agent: finance-agent…, max_per_tx: 100000000000000000000000, daily_cap: 250000000000000000000000}`; sales disabled by default | 0 | 100 Tgas |
| 7 | `approve_recipient(supplier-1…)` | Parent (owner) | FunctionCall | 1 yocto | 30 Tgas |
| 8 | `approve_recipient(supplier-2…)` | Parent (owner) | FunctionCall | 1 yocto | 30 Tgas |
| 9 | Add the restricted key to `finance-agent` | Agent (full-access key) | AddKey FunctionCall(receiver = treasury, methods = [request_payment], allowance = unlimited) | 0 | — |

The parent's balance is checked between steps 1 and 2 (≥ 3.6 NEAR or stop).

### Expected balances after B1

The gas figures below are **worst case**: prepaid gas fully burnt at 1e8 yocto/gas (B0). Actual use should be far lower, because unused gas is refunded.

| Account | Expected | Notes |
|---|---|---|
| Parent | F − 3.2 NEAR − gas (≤ 6 transactions; worst case well under 0.1 NEAR) − 2 yocto | F must be ≥ 3.6 |
| Treasury | ≈ 2.5 NEAR − deploy gas (worst case ≤ ≈ 0.02 NEAR) + 2 yocto | **≈ 1.75 NEAR of it must stay for storage:** code 174,359 bytes + state + allowlist ≈ 174.9 KB × 1e19 yocto per byte |
| Treasury, available for payouts (contract formula) | ≈ 2.5 − 1.75 − 0.01 storage reserve (1,000 bytes) ≈ **0.73 NEAR** | About 2.9 days at the 0.25 NEAR daily cap |
| Finance Agent | ≈ 0.5 NEAR − add-key gas | Gas only |
| Supplier 1 / 2 | 0.1 NEAR each | |

Actual figures are recorded by `02-verify.sh`.

### Partial failure: no unsafe or unrecoverable treasury state
| Failure point | Resulting state | Why it's safe | Recovery |
|---|---|---|---|
| Steps 1–5 (account creation) | Each creation is one atomic transaction: it either fully happens or doesn't | No contract and no agent key yet, so nothing can pay | Re-run. Existing accounts are skipped. If a key wasn't saved, R-B1-9 applies (new names, re-approval). |
| Step 6 (deploy and init) | **Atomic:** deploy and init are one transaction, so a failed init leaves no code (all actions revert) | There's no deployed-but-uninitialised window. `new` is `#[private]` anyway, and only the treasury's own key can deploy. | Re-run. The script deploys only if the account has no code, and **refuses if it has different code**. |
| Between steps 6 and 9 | Contract live with the correct policy; allowlist partial or empty; **no restricted key** | The agent can't sign app payments (no restricted key), and even a direct call by the agent's full-access key (only in your keychain) would hit the contract's checks | Re-run; finished steps are skipped or harmless (re-approving a supplier is a no-op) |
| Step 9 (add key) | Key added or not | — | Re-run. It's skipped if a restricted key exists; a wrong permission is caught by `02-verify` and B2 (R-B1-8) |
| **Wrong code deployed** (shouldn't be possible) | — | The deploy refuses any WASM whose sha256 ≠ the reviewed hash (checked at precheck, at script start, and **immediately before the deploy command**). `02-verify` checks the on-chain `code_hash`. The app's readiness check (Phase 3) refuses any mismatch. | Stop. No in-place fix (R6); a fresh treasury needs re-approval. |

### Hash enforcement (confirmed)

**What must match:** the deployed contract's code hash must **exactly** equal the reviewed Phase 1 artifact.
- **Before deploy:** sha256 `fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad`, 174,359 bytes.
- **After deploy:** on-chain `code_hash` = base58 of that sha256 = `HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt`. That conversion was recomputed independently from the file on 2026-11-09 and matches.

**Where it's enforced:**
1. `00-precheck.sh`
2. `01-provision.sh` at the start and immediately before the deploy
3. `02-verify.sh` (on-chain)
4. the app's readiness check, in Phase 3

**Not to be done:** clean or rebuild `contracts/treasury/target/` before B1. A rebuild may change the bytes, and the scripts would then refuse to deploy.

### Changes made in this review (scripts only)
1. `empty-args` → `json-args '{}'` in `04-b2-negative-tests.sh` (K2, K5) and `emergency.sh` (pause, unpause).
2. An extra WASM hash check immediately before the deploy command (`01-provision.sh`).
3. The opt-in `M5_RESTRICT_NEAR_CLI_NETWORK` setting (`lib.sh`).

All scripts pass `bash -n`. `01-provision.sh` was also run once **without** `--execute` to print its command list. That's a dry run: no signing and no network calls, and no evidence files were created.

## B1 · Results (executed by the owner 2026-11-09; **PASS**, independently verified read-only)

**How it ran:**
- The owner ran `01-provision.sh --execute` in Git Bash, confirming each transaction with `YES`.
- **Two stops happened before transaction 2:**
  1. near-cli asked an unplanned key-type question; the owner aborted with Ctrl+C. Nothing was sent; the account was verified absent afterwards. Fixed by pinning `--signature-scheme ed25519` on the six key-generating commands.
  2. After transaction 1 succeeded, the balance check crashed reading an RPC response with no `result`. Nothing further was sent. Fixed with a ≤ 30 s retry plus a clear STOP. The 3.6 NEAR gate is unchanged.
- The re-run skipped transaction 1 (the account already existed) and completed transactions 2–9.

**Transactions:** all final; all receipts successful; signer, receiver and actions verified against the plan.

| # | Transaction ID | On-chain content |
|---|---|---|
| 1 | `CHi7Pe1uzwK7aEyXDWwgTU4rkwM96NXnMvhJyfTPEeaA` | Faucet `testnet` → `employai-demo.testnet`: CreateAccount, Transfer 10 NEAR, AddKey `ed25519:2Z1xevEHUi7Zg5GoyzW1DnKhDvhoouq3Cqtn4ULSBdig` (full access) |
| 2 | `JB42uFBgWhUcxXooDoMCFKxi28Covsa2HGSgnpPdWBCL` | Parent → `treasury…`: create, 2.5 NEAR, key `ed25519:6AA52F8xqN8xkkuE51Po39YLj6EG7GYHNE9JBkwjM5tM` |
| 3 | `2pXzHsHuCm7mkiT5BfpoXBedZDwPSabFMcjJiczJ9akb` | Parent → `finance-agent…`: create, 0.5 NEAR, recovery key `ed25519:78rzENLHufiG5xYkCrByeaRhYtCBMU3nB3vcBNT4Gdz8` |
| 4 | `GmZ7FmwutQ8cc3S6iCKWu2SxwmzEKnFndmm9fuAAN6hw` | Parent → `supplier-1…`: create, 0.1 NEAR, key `ed25519:8Z4YXmYUh6ZjCiAc7eb1jWrYjPkS17XHLrwQXQgXCadC` |
| 5 | `GXimGRdNHjaNymptFEb1xdah256innRiRM6eNcLe4v33` | Parent → `supplier-2…`: create, 0.1 NEAR, key `ed25519:Hwam5XFGNBvTEeWGBsUVPpPdhej9s97jQSph9qAJpHw2` |
| 6 | `2MkDVmZA8jrQoK7V22Hv64QRQKT1BBnfyUo9cFQ5xeWN` | Treasury → itself: DeployContract + `new{owner: employai-demo.testnet, agent: finance-agent…, max_per_tx: 0.1 NEAR, daily_cap: 0.25 NEAR}` in **one** transaction; event `initialised` (sales disabled) |
| 7 | `Hp3ku28pW2d2JqYderyXSv8nv8dMM8GgcY1RUn4fUCqQ` | Owner → treasury: `approve_recipient(supplier-1)`, 1 yocto; event `recipient_approved` |
| 8 | `2jWkZAXEzWnzDB1pBhrfTT2JtvdTLUTGxoYG7FHa1afQ` | Owner → treasury: `approve_recipient(supplier-2)`, 1 yocto; event `recipient_approved` |
| 9 | `GoNQpk1qDp6xGhHd4VrmYi32zMeoex6c85Mrgx6529th` | Agent → itself: AddKey `ed25519:8qgGrnTtmKw8excey4uPcBdYL9hdsjnv1FzQECjGNFMZ` = FunctionCall{receiver: treasury, methods: [request_payment], allowance: null} |

**Verified state after B1:**
- **Code:** `code_hash` = **`HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt`**, matching the reviewed sha256 `fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad`.
- **Policy:** as initialised; not paused; sales disabled; spent 0.
- **Allowlist:** both suppliers true; the parent, agent and treasury false.
- **Balances:** parent 6.771169 NEAR, treasury 2.498538 NEAR (≈ 1.747 NEAR held for storage), agent 0.499957 NEAR, each supplier 0.100000 NEAR.
- **Actual costs:** each `fund-myself` account creation burnt **0.007115 NEAR**, not the 0.0000825 NEAR near-cli prints as "Transaction fee". The deploy burnt ≈ 0.0015 NEAR.
- **No unexpected activity:** key nonces show transactions signed per key = parent 6, treasury 1, agent recovery 1, restricted key 0, suppliers 0.

**Evidence:** `scripts/m5/evidence/B1/` holds 10 logs (including the aborted first attempt) plus `20261109T141840Z-verify.json` (`02-verify.sh`, 0 failures).

**Not independently verified:** that the Windows keychain holds the private keys for the treasury, agent and supplier keys. Only the parent's entry was confirmed, by name.

## B2 · Results (executed by the owner 2026-11-09; **PASS**, independently verified read-only)

**Restricted-key proof (read-only):** `view_access_key` for `finance-agent.employai-demo.testnet` / `ed25519:8qgGrnTt…` = `{"FunctionCall":{"allowance":null,"method_names":["request_payment"],"receiver_id":"treasury.employai-demo.testnet"}}`. This is the B0-3 fixture for Phase 3: `scripts/m5/evidence/B2/20261109T142202Z-finance-agent-view_access_key.json`.

### Negative tests: all 12 failed as required

| Test | Rejection (from the log's error section) | Included on-chain? | Result |
|---|---|---|---|
| K1 `set_policy` (restricted key) | "Transaction method name <set_policy> isn't allowed by the access key." | No | PASS |
| K2 `pause` | "… <pause> isn't allowed by the access key." | No | PASS |
| K3 `approve_recipient` | "… <approve_recipient> isn't allowed by the access key." | No | PASS |
| K4 `request_payment` + 1 yocto | "Having a deposit with a function call action is not allowed with a function call access key." | No | PASS |
| K5 a call to another account | "Transaction for <employai-demo.testnet> doesn't match the access key for <treasury.employai-demo.testnet>." | No | PASS |
| K6 a 0.01 NEAR transfer | "Transaction requires a full permission access key." | No | PASS |
| K7 add a full-access key (the parent's own `2Z1xevEH…`) | "Transaction requires a full permission access key." | No | PASS |
| C1 payout to the parent (not allowlisted) | Contract panic "Recipient not approved"; tx `46cdG6k5U7pnxmGDU1PRgeRXwueR1WyfETWbtV6EwgEu` | Yes (Failure) | PASS |
| C2 0.11 NEAR, over the limit | "Amount over per-transaction limit"; tx `HWMceSu8rpLJfJ9TCiiNByCLXZivcmsBNyjbe8oXRugF` | Yes (Failure) | PASS |
| C3 request ID `bad` | "Invalid request_id"; tx `7HQS8boHWqzchTdEdZNezFF4Aru9BVKPHPJUsTjtLUsB` | Yes (Failure) | PASS |
| C4 signed by the owner | "Not the registered agent"; tx `Fhs9PZVqweEWzFEWHJBJVwXQB3AttujNKAnYJyBAF2Xt` | Yes (Failure) | PASS |
| C5 `pay_order` + 0.01 NEAR | "Sales disabled"; tx `4GrSt9XzuhTgq667GW5jiQxwTX6gQEzsYyoKQLxK5Bxe`; **deposit refunded** (refund receipt) | Yes (Failure) | PASS |

**Gas:**

| Test | Gas burnt | Cost |
|---|---|---|
| C1 | 1.806 Tgas | 0.000158 NEAR |
| C2 | 1.811 Tgas | 0.000159 NEAR |
| C3 | 1.744 Tgas | 0.000152 NEAR |
| C4 | 1.746 Tgas | 0.000152 NEAR |
| C5 | 1.937 Tgas | 0.000149 NEAR |

That's about 70 times below the 0.01 NEAR worst-case estimate. K1–K7 had no fee: they were never included.

**Verified state after B2 (unchanged apart from gas):**
- policy unchanged; spent 0; `get_request` null for every test ID; allowlist unchanged;
- agent keys: 2. Transactions signed: restricted key 3 (C1–C3 only), recovery key 1;
- parent key: 8 in total (6 in B1, plus C4 and C5);
- balances: parent 6.770867 (−0.000302 = C4 + C5 gas; the C5 deposit came back), agent 0.499488 (−0.000469 = C1–C3 gas), treasury 2.498538 and suppliers 0.100000 each, unchanged.

**How the C transaction IDs were found:** near-cli doesn't print an ID when a contract call fails. Each ID was recovered read-only from the archival RPC: a binary search over historical blocks found where the signing key's nonce rose, and the matching transaction was located in that block.

**Evidence limitation (K1–K7):**
- **What wasn't captured:** the raw network replies.
- **What supports network rejection:**
  1. every error was raised in near-cli's **send** step (`src\transaction_signature_options\send\mod.rs:181`), after signing, where near-cli formats the network's `InvalidAccessKeyError` replies;
  2. the restricted key's nonce shows **only 3** included transactions (C1–C3), so none of K1–K7 reached the chain.
- **What it doesn't rule out:** these two facts prove the transactions weren't executed; together they strongly support, but don't strictly prove, that the network (not near-cli) refused them.

**Classifier correction (2026-11-09):**
- **What was wrong:** the script labelled K1–K3, K6 and K7 "REVIEW", because its patterns didn't match near-cli's wording. It also marked K4 and K5 PASS on words (`deposit`, `receiver`) that appear in the *printed transaction*, not only in the error.
- **What changed:** `04-b2-negative-tests.sh` now classifies on the log's **error section only**, with near-cli's actual wording (plus the protocol error names) and full contract-panic messages.
- **Re-check:** re-classifying the existing 12 logs gives 12 PASS. No B2 transaction was re-run.

**Evidence:** `scripts/m5/evidence/B2/` holds 12 logs plus the key fixture. The B1 evidence is unchanged (hashes re-checked).

## B3 · Results (owner-approved in the app 2026-11-09; **PASS**, independently verified read-only)

The first supplier payment initiated through EmployAI: the real execution runner, security gate with read-only chain checks, owner approval bound to the exact payment, and the Finance Agent's restricted function-call key. The owner clicked Approve; nothing was signed or sent by anyone else.

**Scope (as approved):** one payment, 0.031 NEAR to `supplier-1.employai-demo.testnet`; batch B3 armed in the app with max 1 payment, 0.1 NEAR, 60 minutes; limits 0.1 NEAR per payment and 0.25 NEAR per day; gas budget 0.01 NEAR.

| Item | Value |
|---|---|
| Transaction | `AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP` (FINAL) |
| Signer / key | `finance-agent.employai-demo.testnet` / `ed25519:8qgGrnTtmKw8excey4uPcBdYL9hdsjnv1FzQECjGNFMZ` (restricted FunctionCall key), nonce 276931238000004 |
| Call | `treasury.employai-demo.testnet.request_payment`, deposit 0, prepaid gas 100 Tgas |
| Request ID | `c28dc3a6-223b-447a-8b52-04e0cb39d6c2:payment` (run `c28dc3a6…`) |
| Contract record | `Paid`, attempts 1, requested at block 276,969,509, settled at block 276,969,511 |
| Events | `payout_requested`, then `payout_completed` (request, recipient, amount and agent match) |
| App verification | all four §12 checks passed; attempt `confirmed`; ledger row "NEAR testnet · real transaction" |
| Gas burnt | 0.000477098 NEAR (budget 0.01 NEAR) |

**Timeline (UTC):** run started 20:29:10 → security check WARN `FIRST_INTERACTION` (chain checks passed) → owner approved 20:31:21 → Phase A (approval consumed, batch counted) 20:31:22 → signed and written ahead 20:31:25 → sent and verified 20:31:30 → run completed 20:31:30.

**Balances after (read-only):**

| Account | Before | After | Change |
|---|---|---|---|
| treasury | 2.498538709076408000000002 | 2.467538709076408000000002 | −0.031 NEAR exactly |
| supplier-1 | 0.1 | 0.131 | +0.031 NEAR |
| finance-agent | 0.4994887320824945 | 0.4990116338208649 | −0.000477098 NEAR (gas) |

On-chain `get_spent_today`: 0.031 of 0.25 NEAR. Batch B3 used: 1 of 1 payments, 0.031 of 0.1 NEAR.

**Explorer link** (format still unverified, B0-7): `https://testnet.nearblocks.io/txns/AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP`.

## E and E2 · Finance Agent key rotation (owner-run 2026-11-09; **PASS**, verified read-only)

**Why:** the restricted key's secret (public key `ed25519:8qgGrnTtmKw8excey4uPcBdYL9hdsjnv1FzQECjGNFMZ`) was pasted into a chat transcript, so it was treated as exposed. The NEAR AI API key in the same paste must also be rotated by the owner at cloud.near.ai (not an on-chain action).

| Batch | Action | Signed with | Authority |
|---|---|---|---|
| **E** | `emergency.sh revoke-agent-key --execute`: deleted the exposed restricted key | finance-agent's full-access recovery key (owner keychain) | Pre-authorised emergency procedure (O3) |
| **E2** | `near account add-key … grant-function-call-access --allowance unlimited --contract-account-id treasury.employai-demo.testnet --function-names request_payment` | finance-agent's recovery key | Written sheet in chat; the owner ran it |

**Verified read-only after E2** (`view_access_key_list` on `finance-agent.employai-demo.testnet`, final):
- `ed25519:3WYMJJAsybvTPJHDgeys77PMHARoKKYyFd2iVDBfuRGx`: `FunctionCall { receiver_id: treasury.employai-demo.testnet, method_names: ["request_payment"], allowance: null }`, nonce 276,971,889,000,000 (added around block 276,971,889).
- `ed25519:78rzENLHufiG5xYkCrByeaRhYtCBMU3nB3vcBNT4Gdz8`: FullAccess recovery key, unchanged.
- `ed25519:8qgG…`: **gone**. Verified between E and E2: only the recovery key remained.

**App change:** `APPROVED_ACCOUNTS.agentPublicKey` now pins the new key; the exposed key is refused (a static test forbids it). The new secret lives only in the legacy keychain file named for its public key and in the owner's `.env`. Transaction hashes for E and E2 are in the owner's CLI output (public, not yet copied here). The treasury, its policy and allowlist, and the contract were not touched.

## S2 (first attempt) · approval expired unused (2026-11-09)

Prepared through the app with the rotated key: run `9c970639…`, batch **B3-S2** (1 payment, max 0.031 NEAR, 60 min). Security check **ALLOW**, no reasons (supplier-1 paid before in B3; 0.031 NEAR under the 0.05 NEAR WARN level). The chain checks passed at 21:12:13 UTC (on-chain spent 0.031 of 0.25 NEAR). The owner approval stayed pending and **expired at 21:27:13 UTC**; the run then ended `rejected`. No payment attempt was created and nothing was signed. A fresh S2 approval request is prepared separately when the owner is ready.

## S5 · Kill switch demonstration (live app, 2026-11-09; **PASS**, no payment)

Run `dc509ee0-4cea-4ecb-9342-a5c4cfa58dbc` on the dev server, NEAR testnet mode, batch B3-S2:

| Step | Result |
|---|---|
| Before | Security check ALLOW (real chain checks); approval **pending** for 0.031 NEAR to `supplier-1.employai-demo.testnet`; no payment attempt |
| Kill switch ON (`POST /kill-switch`) | finalised at once: run **cancelled** (`KILL_SWITCH_ACTIVE`), approval **invalidated**, batch B3-S2 **disarmed**; events `approval.invalidated`, `run.cancelled` |
| Try to approve the payment | 409 `APPROVAL_INVALIDATED` |
| Try to advance the run | no-op (advanced 0; still cancelled) |
| Try to start a new testnet run | 409 `KILL_SWITCH_ACTIVE` |
| Try to arm a batch | 409 `KILL_SWITCH_ACTIVE` |
| Ledger | unchanged: 1 verified payment (B3), 0 in progress |
| Kill switch OFF | done after the evidence was read |

**On-chain proof (read-only, before → after):** restricted key `3WYMJ…` nonce **276,971,889,000,000 → 276,971,889,000,000** (no transaction signed with it); `get_request("dc509ee0…:payment")` = `null`; `get_spent_today` 0 → 0; supplier-1 0.131 → 0.131 NEAR; finance-agent balance unchanged.

The later kill-switch points (after approval, after signing, after broadcast) are covered by the automated fake-chain tests in `tests/testnet-payments.test.ts`. They weren't run live, because that would need an approved real payment.

## B3 explorer link · verified (2026-11-09)

- `https://testnet.near.rocks/tx/AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP` (NEAR Rocks, by FastNear) shows the B3 transaction: signer `finance-agent.employai-demo.testnet`, key `8qgG…`, nonce 276931238000004, `request_payment` with the B3 request ID, the 0.031 NEAR transfer to supplier-1, `on_payout` returning `true`, and the `payout_requested` and `payout_completed` events.
- The official NEAR explorer selector (`explorer.testnet.near.org/transactions/<hash>`) links to `https://testnet.nearblocks.io/txns/<hash>`, the format the app used. NearBlocks serves a Cloudflare bot check (HTTP 403) to automated browsers, so it wasn't opened here, and no attempt was made to get past it.
- The app now links to NEAR Rocks first and NearBlocks second.

## S2 · Second supplier payment with the rotated key (owner-approved in the app 2026-11-10; **PASS**, independently verified read-only)

Earlier S2 approvals (runs `9c970639…`, `a38bfed5…` and `b4c50350…`) expired unused; each run ended `rejected` with no payment attempt and nothing signed. This one was approved.

**Pre-checks (read-only, 12:57 UTC):**
- the restricted key `3WYMJ…` was exactly `FunctionCall(treasury, ["request_payment"], allowance null)`, nonce 276,971,889,000,000;
- policy 0.1 / 0.25 NEAR, not paused, sales off, code hash `HvewFdJa…`;
- 0 NEAR spent today; supplier-1 on the allowlist.

Batch **B3-S2c** (`da943574-9946-428e-bdfc-1c17895342a1`): 1 payment, max 0.031 NEAR, armed 12:57:43 UTC for 60 minutes; it replaced B3-S2b, which was close to expiring. Security check: **ALLOW**, no reasons.

| Item | Value |
|---|---|
| Run / approval | `50c6a361-23b7-4d14-aa55-a336129f1f74` / `140d1f32-7316-4188-963d-a68e1ca4844a` (owner approved 13:00:29 UTC) |
| Transaction | `6BV9JEX2bHkEyyYCbFjyuDJtTca8jLekrRP9TA5JRUC4`, final status **FINAL**, `SuccessValue` = `true` |
| Signer / key / nonce | `finance-agent.employai-demo.testnet` / `ed25519:3WYMJJAsybvTPJHDgeys77PMHARoKKYyFd2iVDBfuRGx` (the rotated restricted key) / 276971889000001 |
| Call | `treasury.employai-demo.testnet.request_payment`, deposit 0, prepaid gas 100 Tgas, args `{request_id: "50c6a361-…:payment", recipient: "supplier-1.employai-demo.testnet", amount: "31000000000000000000000"}` |
| Receipts | treasury `payout_requested` → transfer to supplier-1 succeeded → `on_payout` returned `true` with `payout_completed` (request, recipient, amount and agent match) |
| Contract record | `get_request` = `Paid`, attempts 1, requested at block 277,070,726, settled at block 277,070,728 |
| Daily total | `get_spent_today` = 0.031 of 0.25 NEAR (day 20767) |
| App | attempt `confirmed` (one broadcast); run `completed`; payment panel "Paid · verified on NEAR testnet"; ledger row "NEAR testnet · real transaction" |
| Gas burnt | 0.0004777822616296 NEAR (budget 0.01) |

**Timeline (UTC):** approved 13:00:29 → Phase A 13:00:29 → signed and written ahead 13:00:32 → sent and verified 13:00:37 → run completed 13:00:37.

**Balances (read-only, before 12:57 → after 13:01):**

| Account | Before | After | Change |
|---|---|---|---|
| treasury | 2.467538709076408000000002 | 2.436538709076408000000002 | **−0.031 NEAR exactly** |
| supplier-1 | 0.131 | 0.162 | **+0.031 NEAR** |
| finance-agent | 0.4989289710098057 | 0.4984511887481761 | −0.0004777822616296 NEAR (= the gas burnt) |

Explorer: `https://testnet.near.rocks/tx/6BV9JEX2bHkEyyYCbFjyuDJtTca8jLekrRP9TA5JRUC4`. This proves the rotated key end to end: the old key is revoked, and the new restricted key paid exactly once through the app.
