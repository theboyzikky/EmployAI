# M5 decision review · D-M5-1 to D-M5-17

**Status:** review document for the owner, 2026-11-08.
- **Updated 2026-11-08:** the owner proposed resolutions R1–R17 and a correction on unapproved recipients, then resolved open items O1–O5 and required verifications V1 and V2 (all below).
- They **become decisions only with the owner's final implementation approval.** Nothing is implemented.

**Companion to:** the [M5 plan](m5-proposal.md). **Planning only:** no dependencies added, no network calls, no accounts, funding, deployments or transactions.

## Proposed resolutions (owner, 2026-11-08)

| # | Decision | Owner's proposed resolution | Compared with the review's recommendation | Applied in |
|---|---|---|---|---|
| R1 | D-M5-1 library | Approve a **pinned `near-api-js`**, isolated inside the chain module | Same. The exact version is shown for the owner's OK in Phase 3 (checking it needs the npm registry) | Plan §4, §21; doc 06 |
| R2 | D-M5-2 accounts | The **five** proposed testnet accounts | Same | Plan §5.1; docs 02, 06 |
| R3 | D-M5-3 custody | The owner keeps account creation, deployment and contract ownership in their own NEAR CLI keychain. **The server never holds a full-access, treasury-owner or recovery key.** | Same | Plan §2 K2, §5; docs 02, 05 |
| R4 | D-M5-4 amounts | NGN business and NEAR transaction amounts **completely separate**; no automatic conversion; **both sets of limits enforced** | Same | Plan §8.1–8.2; doc 02 |
| R5 | D-M5-5 approval | **Every real supplier payment needs explicit owner approval,** even on ALLOW; BLOCK always prevents payment | Same | Plan §7, §8.3; docs 00, 01, 02 |
| R6 | D-M5-6 upgrades | **No in-place upgrades;** fixes need a separately deployed and verified version | Same | Plan §6.3 |
| R7 | D-M5-7 prior payments | Only **confirmed on-chain payouts** count | Same | Plan §9 |
| R8 | D-M5-8 on-chain pause | **No server-held on-chain pause key in M5.** Keep the in-app kill switch; document an **owner-controlled CLI emergency procedure**. | Same | Plan §14; docs 01, 05 |
| R9 | D-M5-9 customer payments | **Keep `pay_order` in the contract design, disabled** and unavailable through the app in M5. Customer payments and revenue split stay in the roadmap; the deferral is made explicit; no mandatory requirement is silently removed. | Same as option B | Plan §6.1 C11, §23; docs 00, 01, 08 |
| R10 | D-M5-10 ledger | **Public ledger in M7;** M5 includes the private owner ledger | Same | Plan §16, §23; docs 01, 08 |
| R11 | D-M5-11 signals | **Public RPC** for recipient existence and contract or code identity; NearBlocks age and activity in **M6** | Same | Plan §9; docs 01, 08 |
| R12 | D-M5-12 retry | Failed payouts need a **manual retry, fresh security evaluation and fresh owner approval**; idempotency kept; no duplicate successful payment | Same | Plan §11, C3 |
| R13 | D-M5-13 contract | **C1–C12 except C7** (guardian); the design reflects R9 | Same | Plan §6.1 |
| R14 | D-M5-14 transactions | **Every real testnet transaction, setup and deployment included, needs the owner's written batch approval first.** The owner runs owner-controlled operations. | Same. The plan adds **in-app batch arming** so payments outside an approved batch are refused (§8.4). | Plan §8.4 |
| R15 | D-M5-15 env template | Clean `.env.example` (remove stale signer and OutLayer variables; add only the Finance Agent names). **Never read or modify `.env`.** | Same. Applied in Phase 3, **not** in this planning step. | Plan §3.5, §21; doc 06 |
| R16 | D-M5-16 limits | **0.1 NEAR per payment, 0.25 NEAR per day,** alongside the existing NGN limits | Same | Plan §8.2 |
| R17 | D-M5-17 timebox | **Target Nov 9–12, 2026.** A target, not permission to cut security or recovery requirements. | Same | Plan §21; doc 08 |

**Correction (owner, 2026-11-08), unapproved recipients:**
- An app-level owner approval must never bypass the treasury contract's on-chain recipient allowlist. **An unapproved recipient can't receive funds.**
- Adding a recipient is a separate owner-authorised on-chain operation, followed by verification.
- **Applied in:**
  - `00-mvp-scope.md` success criterion 3;
  - the plan's §9: `RECIPIENT_NOT_APPROVED_ONCHAIN` is a hard BLOCK, and the add-recipient procedure is defined;
  - doc 02 Diagram 4;
  - doc 05 T3 and rule 8.

## Open items O1–O5: resolved (owner, 2026-11-08)

| # | Item | Resolution |
|---|---|---|
| O1 | Customer-payment key custody vs R3 | **Deferred to M6.** No full-access server key and no exception to R3 in M5. |
| O2 | Schedule for the deferred mandatory items | **All mandatory requirements stay in the roadmap.** The M6/M7 dates (Nov 12–13) are provisional; security, recovery and testing are never cut to meet them. |
| O3 | Emergency speed vs R14 | **Standing pre-authorised emergency procedure:** on-chain pause and agent-key revocation, executed by the owner through the CLI and recorded afterwards as batch E. The server never gets a pause or owner key. |
| O4 | Unapproved recipient in test runs | **BLOCK in both test and real runs.** The M4 gate change waits for checkpoint CP-1, where the exact diff is shown before any M4 code changes. M4 regression expectations change only where needed: exactly one, `tests/security-gate.test.ts:44`, WARN → BLOCK. |
| O5 | Reading of PRD AT-08 under R5 | **A security-authorised and explicitly owner-approved testnet payout.** |

## Verifications required before implementation approval (owner, 2026-11-08)

| # | Requirement | How the plan meets it |
|---|---|---|
| **V1** | Batch arming must not replace individual approval. Each approval binds the exact request ID, recipient, amount, workflow and approval fingerprint, and applicable policy version; changes invalidate it. | [Plan §8.3](m5-proposal.md#83-approval-r5-and-exact-binding-v1):<ul><li>**one approval per payment;** a batch of N needs N approvals;</li><li>**the testnet action hash binds** the request, run and business IDs; the recipient account; the NEAR **and** NGN amounts; the workflow ID, version and approval fingerprint; the NGN policy version; the NEAR policy version (a hash of the on-chain policy snapshot plus config limits); network, contract, expected code hash, agent and method; the gate decision ID; and the batch;</li><li>**it's recomputed** at the click, in Phase A and before signing; any difference → `APPROVAL_STALE`, 0 signatures, fresh evaluation and approval;</li><li>**tested per field (AC5-20).**</li></ul>M4 test-run hashes are unchanged; they're protected by the pinned fingerprint and each run's own copy of the demo data. |
| **V2** | Document and test the contract's asynchronous payment and callback behaviour: failed-transfer refunds, daily rollback across UTC midnight, failure reporting, request-ID handling and safe manual retries. No rollback claim until the tests prove it. | [Plan §6.5](m5-proposal.md#65-asynchronous-payment-and-callback-behaviour-v2):<ul><li>the receipt timeline and rules R-A1 to R-A8 (panic reverts everything; transaction success ≠ payout success; refunds are protocol receipts and may arrive in either order relative to the callback; rollback against the request's own day; legal request-ID transitions only; failure reporting; callback gas; safe retry);</li><li>**12 contract tests, T-A1 to T-A12,** including the UTC-midnight cases T-A4 and T-A5 and the retry rules T-A7;</li><li>**testnet evidence** S8 (refund via receipts and balances) and S8b (same-ID retry from Failed);</li><li>**AC5-11 and AC5-21;** constraint K6b forbids "rolled back" or "refunded" claims before the evidence.</li></ul> |

## Provisional preferences (owner, 2026-11-08; starting points, not approvals)

| # | Preference | Effect on my recommendations |
|---|---|---|
| P1 | Every real supplier payment in M5 needs explicit owner approval, even on ALLOW | **Adopted.** D-M5-5 changes from "ALLOW executes automatically" to "approve every payment". |
| P2 | M5 focuses on supplier payments; customer payments and revenue split stay out unless a compelling technical reason exists | **Adopted for the app.** One technical reason is raised for the contract only (D-M5-9, option B). |
| P3 | Keep the in-app kill switch; no separate on-chain pause key without a clear security justification | **Adopted.** On review the justification is not strong enough for M5 (D-M5-8). |
| P4 | All real testnet transactions happen in batches the owner explicitly approves | **Adopted.** This extends to owner-run provisioning scripts (D-M5-3, D-M5-14). |
| P5 | Business amounts in NGN stay separate from NEAR transaction values; no automatic conversion | **Adopted.** D-M5-4 is reworded: two separate amounts, both checked. |
| P6 | No dependencies, network calls, accounts, funding or deployment yet | Respected. Several decisions decide what is allowed *later*, and are marked as such. |

## The 17 decisions

**Blocks?** says which M5 phase (from the plan's §21) can't start until the decision is made:
- 1 = contract;
- 2 = provisioning;
- 3 = chain layer;
- 4 = runner;
- 5 = UI;
- 6 = live verification.

| # | Decision and what it changes | Recommendation | Why | Security implications | Cost or dependency | If deferred | Blocks? |
|---|---|---|---|---|---|---|---|
| **1** | **D-M5-1 · NEAR client library.** What signs transactions and calls RPC in the app. Changes `package.json`, plus a new server-only `src/lib/chain/`. | **`near-api-js`, one exact pinned version, server-only, used only behind the `ChainPort` interface.** Version chosen at implementation time with your approval (checking the current version is itself a network call). | The official SDK, already named in doc 06, with an installed skill. Correct transaction serialisation and signing is the riskiest code to write by hand. | **Reduces risk** compared with hand-rolled Borsh and ed25519 code. Supply-chain exposure is contained: one pinned version, lockfile reviewed, imported only in `src/lib/chain/`, with a static test so `src/lib/runs` and `src/lib/security` never import it. | **One new runtime dependency** (plus its sub-dependencies), $0. Breaks the "no new dependencies" default, hence this decision. | Phases 1–2 can proceed. Phases 3–6 can't: no app can sign. | **Phase 3** |
| **2** | **D-M5-2 · Which testnet accounts exist.** Sets the provisioning script and the funding need. | **5 accounts in M5:** parent `employai-demo.testnet` (if free), `treasury.`, `finance-agent.`, `supplier-1.`, `supplier-2.`. **Not in M5:** `scam-supplier.` (M6 attack demo), `guardian.` (D-M5-8 = no), `contributors.` and `customer-demo.` (D-M5-9 = out). The "not approved" bypass test uses the parent, which exists and isn't on the allowlist. The failed-payout test uses an approved but **never-created** ID, so it needs no account. | The smallest set that proves supplier payouts, the allowlist, caps and failure handling. Fewer accounts, keys and faucet requests. | Fewer keys to hold. **Only one key reaches the server** (the Finance Agent's function-call key); every other key stays in your NEAR CLI keychain. | ≈ 3.5–4 testnet NEAR from the faucet (estimate; not measured). No dependency. | Phase 2 waits. Checking whether the parent name is free is a read-only network call, so it needs your OK too. | **Phase 2** |
| **3** | **D-M5-3 · Who creates, funds and deploys, and who owns the contract.** Decides custody of every full-access key, and the contract's `owner`. | **You run every script** that creates, funds or deploys, with keys in your NEAR CLI OS keychain. I write and review the scripts and read their output. **Contract `owner` = the parent account** (your key). The treasury account's own full-access key stays with you (see D-M5-6). **The server never holds an owner, treasury or recovery key.** | Keeps signing authority for anything but `request_payment` out of the app and away from me. Matches K2 and the B2 requirement. | **Central control.** A compromised server or app can at most call `request_payment` within the contract's checks. Your keychain becomes the single point of trust: protect it, and keep the function-call key's recovery key there too. | $0. Your time for Phase 2 (≈ 30–60 min estimated). | Phase 2 can't run. | **Phase 2** |
| **4** | **D-M5-4 · Amounts: NGN business values vs NEAR transaction values.** How a payment request gets its NEAR value, and how limits are checked. | **Two separate amounts, never derived from each other:** the NGN business amount (illustrative, from demo data, as in M4) and the **NEAR transaction value** from a separate testnet price list in demo data (NEAR per unit, sized to ≈ 0.02–0.06 NEAR per payout). **Both are checked:** the NGN business policy (M4 limits) **and** the NEAR policy (the contract's mirror); the stricter result wins. The UI shows both, labelled "business amount (illustrative NGN)" and "testnet transaction (NEAR)". No exchange rate is shown or implied. | Honours P5 and the M3 "no conversion" decision. Keeps M4 test runs unchanged. Small NEAR values keep faucet needs low. | Two policies can disagree; "stricter wins" means no path is weaker than either. The action hash binds **both** amounts, so neither can be changed after approval. | $0. Demo data v3 adds a NEAR price list and NEAR limits. | Phase 4 can't define the payment request or the gate's NEAR checks. | **Phase 4** (and the scenario tuning) |
| **5** | **D-M5-5 · Approval of real payments.** Does ALLOW pay without the owner? | **Every real testnet payment needs your explicit approval in M5, whatever the gate says.** The gate still evaluates and records ALLOW, WARN or BLOCK: BLOCK still means no approval is possible, and WARN reasons are shown. Approval cards say "Required for every real payment in M5". Automatic ALLOW execution is a later, separately approved switch. | P1. A human check on every first real transaction, while the signer, contract and key restrictions are new and unproven on-chain. | **Strongest control.** A compromised agent or a gate bug can't move funds without a human click. Residual risk: approval fatigue; mitigated by showing the exact account ID, NEAR amount, network and "signs a real testnet transaction". | $0. | Phase 4 can't finalise the approval path. | **Phase 4** |
| **6** | **D-M5-6 · Contract ownership and upgrades.** Who can change the deployed code, and how changes are made. | **You keep the treasury account's full-access key** in your keychain (you can redeploy in an emergency). **Policy: no in-place upgrades in M5.** Any code change after deployment goes to a **fresh account** (`treasury-v2`) with its own verification, and the old contract is paused and emptied with `withdraw`. The recorded code hash is the reference; the readiness check refuses a mismatch. | Testnet accounts are cheap. A fresh deployment is easier to verify than migrating state. Locking the contract (deleting all keys) leaves no way to fix a bug. | Whoever holds that key can replace the code and take the funds: a **trust assumption on you**, stated in the M5 report. The app detects any code change through the code-hash check and stops paying. No upgrade path exists for an agent or the server. | $0. A redeploy costs ≈ 1.5–2 NEAR of storage (faucet). | Phase 1 can still be written, but whether it needs a `migrate` method depends on this. | **Phase 1** (design), **Phase 2** (custody) |
| **7** | **D-M5-7 · What counts as "paid before" on testnet** (`FIRST_INTERACTION`). | **Only verified testnet payouts** in this business's ledger. Fictional registry history and test-run rows never count. | Truthful: a real first payout is a real first interaction. With D-M5-5, approval is required anyway, so this only changes the reasons shown. | Safe default: no fictional trust carried into real payments. | $0. | No impact on M5 execution (approval is always required); it would matter only if automatic ALLOW is enabled later. | **No** (default to the recommendation) |
| **8** | **D-M5-8 · On-chain pause from the in-app kill switch** (a guardian key). | **No guardian key in M5.** The in-app kill switch (M4) stays. It also refuses signing at every pre-broadcast point (plan §14). The **on-chain pause is an owner-run script** (`scripts/pause`), shown in the UI as a command plus the contract's paused state (read-only). The contract keeps `pause` and `unpause` owner-only; no guardian role. A **key-revocation drill** (delete the function-call key) is documented as the emergency stop for a leaked key. | P3. The justification for a guardian is weak in M5. A leaked function-call key can only pay **approved suppliers within the daily cap**, so funds can't reach an attacker. You can pause or revoke from the CLI. A guardian adds a second server-held key, accounts and contract surface. | The in-app switch can't stop someone using a **leaked key outside the app**, or a transaction already broadcast. Exposure is bounded by the contract (allowlist and ≤ 0.25 NEAR a day); stopping it needs your CLI action (pause or key deletion). | $0. One fewer account and key. | Nothing blocked. A guardian can be added later through a fresh deployment (D-M5-6). | **No** (Phase 1 needs the yes/no: guardian code or none) |
| **9** | **D-M5-9 · Customer payments (`pay_order`) and revenue split.** | **App: out of M5** (P2): no customer key, no contributors account, no sale flow. **Contract, two options:** (A) remove `pay_order` from v1 entirely; (B) keep a fixed, unit-tested `pay_order`, **disabled by default** (an owner-only `sales_enabled = false`). **I lean towards B**, for one technical reason: requirements B4, B5, B8 and B12 are *mandatory* for the business track, and adding the method later means a fresh deployment, re-provisioning and re-verification (D-M5-6). If you'd rather keep v1 minimal, A is sound; the cost is a second deployment in M6 or M7. | P2, and supplier payouts are the security-critical core. Option B avoids a predictable redeploy for little added surface (disabled, tested, owner-gated). | **A:** smallest contract surface. **B:** the disabled method can't be called (the flag is checked first) and only you can enable it. Either way, **no customer key reaches the server in M5.** | $0. B adds ≈ 5–15 KB of wasm (≈ 0.05–0.15 NEAR of storage, estimate). | **Mandatory track requirements stay open:** B8 (sale to payout < 2 min), B4, B5, B12, and journey step 8(a). They must land in M6 or M7, or be accepted as gaps. | **Phase 1** (A or B) |
| **10** | **D-M5-10 · Public ledger page** (B7). | **Defer to M7.** M5 builds the **owner's ledger view** (test-run, testnet and off-chain rows with labels and explorer links) and the data model the public page will need. | It's presentation; supplier-payout correctness comes first. | A public page exposes business activity; deferring avoids designing visibility rules now. | $0. | B7 (mandatory) stays open until M7. | **No** |
| **11** | **D-M5-11 · Network signals for the gate.** | **M5: RPC only:** the recipient account exists (`view_account`) and its code hash is checked against the first one seen. Both are needed for beneficiary verification. **M6: NearBlocks** account age and activity (security track). Unavailable signals → WARN (approval is required anyway). | RPC is already on the payment path. NearBlocks is a second free external service, best added with the M6 security work. | Without the existence check, a typo'd or deleted recipient would reach the contract and fail on-chain (refunded). The check stops it before signing. | $0, public RPC. **Network calls at run time** (with fakes in tests). | Beneficiary verification is incomplete; the contract still enforces the allowlist. | **Phase 4** |
| **12** | **D-M5-12 · Retry after a failed payout** (transfer failed, funds refunded). | **Only you can start a retry** ("Retry payment"), with a fresh gate check and a fresh approval, reusing **the same request ID**. The contract allows a retry only with the same recipient and amount (C3). **No automatic retry** of a failed payout. Safe automatic recovery is limited to cases where **nothing was executed** (pre-signing errors, re-sending identical signed bytes, definitively rejected transactions). | A failed transfer usually means a bad recipient. Retrying blindly repeats the fault. Keeping the request ID preserves the at-most-once guarantee. | No double payment: the contract refuses Pending or Paid, and a retry needs a new human approval. | $0. | Failed payouts end the run; you start a new run (a new request ID). Acceptable but clumsier. | **Phase 4** (it's in the contract via D-M5-13) |
| **13** | **D-M5-13 · Contract v1 changes C1–C12.** | **Approve C1–C6, C8–C10 and C12. Drop C7** (guardian; follows D-M5-8). **C11** follows D-M5-9 (A: remove `pay_order`; B: fix it and add the `sales_enabled` flag). Also confirm `near-sdk` stays **5.29.1** (already compiled offline) unless you approve an upgrade. | Fixes every confirmed spike issue and F1–F9. The most important: the request status map, explicit callback gas, rollback on the right day, private init, one-yocto owner methods, `withdraw`, `set_policy`, `remove_recipient`, and the `get_request` view. | Closes ownership takeover at deployment (F4), function-call keys reaching owner methods (F5), and false success (F2, F3). Adds owner powers (`withdraw`, `set_policy`) that only your full-access key can call. | $0. Offline build and test. The wasm size sets the storage NEAR. | Phase 1 can't start. | **Phase 1** |
| **14** | **D-M5-14 · How real transactions are approved.** | **Every transaction goes in an explicitly approved batch,** including provisioning. Each batch is a written list:<ul><li>exact transactions</li><li>accounts</li><li>maximum NEAR moved and maximum gas</li><li>who triggers it (you, by script or a UI click)</li><li>a time window</li></ul>You approve it in chat before anything runs. **I never hold a full-access key and never trigger a transaction.** Payment transactions come only from your approval clicks in the app, within an approved batch. **Read-only RPC queries** during implementation also need a one-time approval (P6). | P4. A complete, human-auditable list of everything that touched the chain. | Prevents surprise transactions and accidental spending of faucet funds. Combined with D-M5-5, you approve both the batch and each payment. | $0, testnet. Your time. | Phase 6 waits. | **Phase 2, Phase 6** |
| **15** | **D-M5-15 · `.env.example` template** (never `.env`). | **Update the template:** add `NEAR_FINANCE_AGENT_ACCOUNT_ID` and `NEAR_FINANCE_AGENT_PRIVATE_KEY` (empty placeholder); remove the stale `NEAR_SIGNER_SECRET`, `OUTLAYER_API_KEY` and `OUTLAYER_BASE_URL`. **You** put the real key in `.env` yourself. | The template should match the code. No secret is ever written by me. | Removing stale names avoids someone putting a full-access key in a variable that sounds generic. Placeholders only. | $0. | You'd set up `.env` without a template; workable. | **Phase 3** (soft) |
| **16** | **D-M5-16 · Demo limits.** | **NEAR (on-chain and app mirror):** 0.1 per payment, 0.25 per day. The approval threshold is irrelevant while every payment needs approval (D-M5-5); keep 0.05 for the reasons shown. **NGN business policy:** unchanged from M4 (threshold ₦50,000, maximum ₦250,000, daily ₦500,000). Scenario prices tuned so each scenario gives the same outcome in both currencies (for example, the price spike exceeds both maximums). | Small caps bound the worst case: ≤ 0.25 NEAR a day can leave the treasury even with a leaked key, and only to approved suppliers. | The daily cap is the real damage limit for D-M5-8's residual risk. | Sets the treasury float (≈ 0.5–1 NEAR is enough). | Deployment can't be initialised; demo data v3 can't be tuned. | **Phase 2** (init values), **Phase 4** |
| **17** | **D-M5-17 · Timebox and cut list.** | **Target Nov 9–12** (one day more than in 08, because Phase 2 and every batch need your time). Features end by **Nov 12**, leaving Nov 13–14 for M6 and M7 polish. **Cut list (presentation only):** live status animation; ledger polish. Already out of scope: the public page, guardian, customer payments. **Never cut:** contract fixes, key-permission check, write-ahead and reconciliation, verification, kill-switch rules, the ≤ 1 payout invariant, owner approval of every payment. | Realistic given owner-run steps. Protects the never-cut items. | Ensures safety items aren't traded for the date. | — | The schedule is unclear; M6 and M7 squeezed. | **No** (planning) |

## Conflicts and dependencies (as identified before the resolutions)

What happened to each conflict:
- **Conflict 1** is resolved by the owner's correction.
- **Conflicts 2 and 3** are resolved by making the deferrals explicit in 00, 01 and 08, but leave open items O2 and O5.
- **Conflict 6** is handled by batch B0.

### Conflicts with existing documents or requirements (each needs your call)
1. **The scope doc vs the contract (pre-existing):**
   - **The conflict:** success criterion 3 in `00-mvp-scope.md` says "a payment to a **non-approved recipient** gets WARN, the owner approves it, and it's paid". The contract rejects any non-allowlisted recipient (K3), whatever the owner approves in the app.
   - **Recommendation:** reword it to "a supplier **never paid before** (approved, `FIRST_INTERACTION`) gets WARN, the owner approves it, and it's paid". Adding a recipient stays a separate owner action: an app approval plus the on-chain `approve_recipient` script.
2. **D-M5-5 (approve every payment) vs AT-08 "ALLOW, paid" and the autonomy theme (B13):**
   - **The conflict:** with every payment approved, no real payment is autonomous in M5.
   - **Recommendation:** redefine AT-08 for M5 as "gate ALLOW → owner approves → paid". Show the ALLOW decision on screen. Keep the M4 test runs as the autonomy demonstration (labelled). Automatic ALLOW becomes a later, separately approved switch.
3. **D-M5-9 (customer payments out) vs mandatory B4, B5, B8 and B12, journey step 8(a), success criterion 2 and the M5 milestone row** ("the full journey works on testnet", "sale-to-payout under 2 min"):
   - **The consequence:** these move to M6 or M7, or are accepted as open gaps. The 08 M5 row and Gate 4 wording must change.
   - **Contract note:** option B avoids a second deployment for them.
4. **D-M5-8 (no guardian) vs B6 and AT-11:** **no real conflict.** D-22 already makes the on-chain pause an owner script in the MVP, and the in-app switch still satisfies "refuses new runs, invalidates approvals, signer refuses". AT-11 evidence becomes your pause transaction (in an approved batch).
5. **D-M5-4 (two currencies) vs the gate's single-currency policy:**
   - **The change:** the gate needs both policies, with "stricter wins". The demo scenarios must be tuned so outcomes agree across currencies; otherwise a scenario could WARN in NGN and ALLOW in NEAR.
   - **Mitigation:** a test asserts each scenario's outcome in both currencies.
6. **P6 (no network calls yet) vs Phase 0 read-only checks:** confirming the parent name and the RPC response shapes needs read-only network calls. They wait for your approval under D-M5-14.

### Dependencies between decisions
| Decision | Depends on | Why |
|---|---|---|
| D-M5-2 (accounts) | D-M5-8, D-M5-9 | The guardian, contributors and customer accounts exist only if those are yes |
| D-M5-13 (contract changes) | D-M5-8, D-M5-9, D-M5-12 | Whether C7 is in, C11's option A or B, and the retry rule in C3 |
| D-M5-6 (upgrade policy) | D-M5-9, D-M5-13 | What's left out of v1 needs a fresh deployment later |
| D-M5-12 (retry) | D-M5-13 (C3), D-M5-5 | The contract must allow a same-ID retry; retries need approval |
| D-M5-7 (prior payments) | D-M5-5 | Matters only once automatic ALLOW exists |
| D-M5-16 (limits) | D-M5-4, D-M5-5 | NEAR values and threshold relevance |
| D-M5-15 (env template) | D-M5-1, D-M5-8 | The variable names depend on the library and the guardian |
| D-M5-14 (batches) | D-M5-3 | Provisioning scripts are batches too |
| D-M5-17 (timebox) | D-M5-3, D-M5-14 | Your availability for owner-run steps |

### Smallest set needed to start (in order)
1. **Phase 1 (contract, offline)** needs D-M5-13, D-M5-9 (A or B), D-M5-8 (guardian yes or no), D-M5-6 and D-M5-12. These involve no network, accounts or dependencies.
2. **Phase 2 (provisioning)** needs D-M5-2, D-M5-3, D-M5-14 and D-M5-16.
3. **Phase 3 (chain layer)** needs D-M5-1 (the dependency) and D-M5-15.
4. **Phase 4 (runner)** needs D-M5-4, D-M5-5 and D-M5-11. D-M5-7 has a safe default.
5. **Non-blocking:** D-M5-10 and D-M5-17.

## Changes from the M5 plan's original recommendations
| Decision | Plan (2026-11-08) | This review |
|---|---|---|
| D-M5-2 | 6 accounts | **5** (scam fixture moves to M6) |
| D-M5-4 | NEAR-native prices; NGN in test runs only | **Both amounts, separate, both checked** (P5) |
| D-M5-5 | ALLOW executes automatically within caps | **Owner approval for every real payment** (P1) |
| D-M5-8 | Guardian pause key | **No guardian**; owner pause script + revocation drill (P3) |
| D-M5-9 | Include `pay_order` if funding allows | **App: out** (P2); contract option A or B |
| D-M5-13 | C1–C12 | **C7 dropped**; C11 per D-M5-9 |
| D-M5-14 | Owner approves live batches | **Every** transaction, provisioning included, in written batches; read-only RPC needs approval too |
| D-M5-17 | Nov 9–11 | **Nov 9–12** |

The plan's sections affected by these changes are §5 (accounts), §8 (limits), §14 (kill switch), §19 (scenarios S1, S2, S5), §20 (AC5-12) and §21 (phases). They'll be revised once you decide.
