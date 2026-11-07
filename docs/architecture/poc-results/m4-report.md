# M4 report · Workflow execution and agent collaboration (test runs)

**Date:** 2026-11-07
**Status:** implemented, **uncommitted**, waiting for the owner's review. Nothing is pushed.
**Plan:** [m4-proposal.md](../m4-proposal.md), with decisions D1–D16 and D18–D23 (D17 dropped) and constraints C1–C7.

## Summary

An approved, fingerprinted restaurant workflow now runs as a labelled **test run** on fictional demo data, from the new **Runs** tab:
- The Business Orchestrator hands work to the Order, Inventory, Procurement and Finance Agents, and every hand-off appears in a live timeline.
- Every tool call passes the security gate, and payment requests pass all nine rules.
- The owner sees and decides WARN approvals. A payment request ends, at most, in a **simulated outcome** labelled "Test run — no transaction". No money moves, nothing is signed, and nothing leaves the app.
- The in-app kill switch, run pause and stop, and agent pause all work, including while a batch is running.

| Check | Result |
|---|---|
| Unit and route tests | **283 / 283** (99 new for M4, 184 existing unchanged) |
| `tsc --noEmit` | clean |
| `next build` | passes (all 9 new routes and the `/w/[id]/runs` page) |
| `git diff --check` | clean |
| Browser (in-app, dev server) | all five scenarios, approve, reject, stop, kill switch, agent pause, the legacy business, mobile 375 px, both themes |
| Dev store | backed up before the browser checks and restored after: sha256 `0b11fc82…` identical |

## Owner conditions for implementation

| Condition | How it is met |
|---|---|
| Within M4 scope and C1–C7 | **Only local fictional demo data (C1).** Simulations are labelled and make no requests (C2). Finance prepares requests through the gate, and even an approved request only records a simulated outcome (C3). There is no signer, NEAR or contract code (C4). Fingerprints are checked at start, before every step and at payment (C5). M3 data is preserved, and legacy versions need re-approval (C6). C7 is covered by the tests below. |
| Explicitly single-process; no multi-instance claim | **Stated in code comments, doc 02, doc 03 and here.** Safety comes from one process-wide lock registry and one serialised store queue. That is **not** production or multi-instance concurrency safety. |
| Shared lock and serialised write queue preserved | **Both mechanisms are intact.** Run operations wait for the lock (FIFO, ≤ 5 s). Discovery and workflow edits keep their fail-fast codes. Control signals (kill switch, pause, stop) write through the queue without the lock, then finalise under it. |
| Handlers side-effect-free | **Agent handlers are pure functions on a copy, and only the runner commits.** Static tests enforce this: no network, process, signer, NEAR or contract references in run or security code, and handlers can't reach the store. |
| Idempotency, recovery, conditional writes, payment safeguards, fingerprints, audit | All are implemented and tested (see the acceptance criteria). |
| No AI calls, `.env` change, paid services, accounts, funding or deployment | **None of these happened.** The agents are rule-based (offline), and `.env` is untouched. |
| Nothing pushed; changes local | **Nothing is committed or pushed.** |

## What was built, by phase

1. **Foundations:**
   - optional store collections for runs, steps, decisions, approvals, ledger and activity, with `transact` and `readState`;
   - the repository singleton;
   - the shared business lock (`src/lib/locks.ts`);
   - the compare-and-set run repository with append-only records and copy-on-read;
   - kill-switch and agent-pause fields;
   - the approval fingerprint (`sha256-canonical-json-v1`), recorded at approval;
   - start-time eligibility with nine ordered refusals.
2. **Gate and authorisation:**
   - a pure `evaluate` in the doc 05 rule order, with reason codes and plain-language text;
   - use-once authorisations bound to an action hash, with a 15-minute expiry and invalidation.
3. **Runner, agents, tools and scenarios:**
   - bounded `advanceRun` (≤ 5 steps / 1.5 s, 15 s lease);
   - nine run statuses, interruption detection and resume, and payment reconciliation by `request_id`;
   - the tool registry and broker with data scopes, and five rule-based agents;
   - demo data v2 with five scenarios.
4. **Routes and controls:**
   - start (create only, `Idempotency-Key`), advance (the only step-executing route), read-only GETs;
   - pause, resume and stop, the approval decision, the kill switch, and agent pause on the team route.
5. **Runs tab:**
   - **Page setup:** eligibility with a link to the right fix, labels ("Rule-based agents (offline)", "Demo data · fictional", "Test run — no transaction"), "What this workflow addresses" (from the case file, separate from demo data), and a scenario picker with expected decisions.
   - **Running:** the advance loop (one request at a time, back-off retry, polling only while waiting) and a live timeline with hand-offs, tools and simulation labels.
   - **Owner controls:** an approval card with a confirmation step, pause, resume, and stop with a confirmation step.
   - **Results and history:** expected vs actual, the security panel, labelled ledger rows, run history and agent pause.
   - **Across the workspace:** a kill switch in the header of every tab.
6. **Verification and docs:** this report, plus corrections to docs 02, 03, 04, 05 and 08 and the decision log.

## Acceptance criteria

| AC | Criterion | Result | Evidence |
|---|---|---|---|
| AC-1 | Only the current approved, fingerprinted version runs | **Pass** | Eligibility tests for every refusal. In the browser, the legacy pre-M3.5 business is refused (`DISCOVERY_INCOMPLETE`, "Back to discovery"), and the kill switch blocks the UI and the API (`KILL_SWITCH_ACTIVE`). |
| AC-2 | Pinned version; a change is detected at start, before each step and at payment | **Pass** | "the approved workflow changed after start → failed WORKFLOW_CHANGED"; fingerprint tests. |
| AC-3 | Legacy versions preserved; re-approval required | **Pass** | "legacy approvals are left untouched". In the browser, the legacy business keeps its approved workflow, and the Workflows notice explains that a fresh discovery is needed. |
| AC-4 | Re-validated against the current team at start | **Pass** | `WORKFLOW_INVALID` eligibility test. |
| AC-5 | Five scenarios: expected = actual | **Pass** | Runner tests for each scenario, and browser runs of all five (see the table below). |
| AC-6 | Hand-offs fully recorded, identity set by the runner | **Pass** | Runner test "every hand-off records requester, assignee, task, tools and data". The timeline shows "Business Orchestrator → agent · task". |
| AC-7 | No tool or data outside the agent and step; no money tool for the Orchestrator; no transfer for Finance | **Pass** | Broker and catalogue tests. |
| AC-8 | Every tool call gated (1–3); payments 1–9 | **Pass** | Gate and broker tests; the kill switch, a paused agent and a missing policy block ordinary tools too. |
| AC-9 | Rule order and boundaries | **Pass** | Ordering, threshold (equal = ALLOW, +₦1 = WARN) and daily-limit boundary tests. |
| AC-10 | Payee, per-payment and daily limits, duplicates | **Pass** | Gate tests; the price spike is BLOCKed with `OVER_TX_LIMIT`. |
| AC-11 | Use-once, hash-bound authorisation | **Pass** | The hash changes with payee, amount, request, run or business; a used, expired, invalidated or mismatched authorisation is refused. |
| AC-12 | Approve (re-checked), reject, expiry; no double approval | **Pass** | Runner and route tests. The browser approve path completes with one simulated row; reject gives "You declined the payment" and no ledger row. |
| AC-13 | No duplicate payment from a repeated start or approval (AT-07) | **Pass** | Idempotent start; "a second decision is refused … exactly one payment outcome". |
| AC-14 | Kill switch, agent pause, paused Finance BLOCKed (AT-11, in-app) | **Pass** | Tests, plus the browser: the kill switch on a waiting run → cancelled, approval invalidated, starts refused. Pausing the Finance Agent pauses the run before its step, and resuming the agent resumes the run, which completes. |
| AC-15 | Only advance executes; GET never mutates; controls during a batch; no lost updates; serialised | **Pass** | "GET never changes the store file" (byte-identical); concurrent advances serialised; kill switch, pause and stop during a step; interleaved writes. |
| AC-16 | Interruption and recovery; payment never repeated; store loads unchanged | **Pass** | Lease, interrupted, resume (attempt 2) and crash-at-payment tests; a copy of the real store loads unchanged. |
| AC-17 | No external side effects | **Pass** | Static tests; `fetch` throws in the test setup; simulations labelled. |
| AC-18 | Simulated payments only, labelled, `tx_hash: null`, never a prior payment | **Pass** | The New supplier scenario is WARN `FIRST_INTERACTION` every time; ledger rows are labelled "Test run — no transaction". |
| AC-19 | Runs never write to the profile or case file | **Pass** | Runner and route tests (D15). |
| AC-20 | "What this workflow addresses" shown, separate from demo data | **Pass** | Route test and browser check ("You asked for: …", with its basis). |
| AC-21 | Append-only, complete activity record | **Pass** | Repository tests; the activity events recorded during the browser session include every hand-off, decision, approval, pause, resume and cancel. |
| AC-22 | Reduced teams; quality bar | **Pass** | Reduced team (Order Agent only) test. All tests, `tsc`, build and diff check pass; mobile and both themes checked; WCAG AA; no overflow; reduced motion respected. |

## Browser results (in-app browser, fictional fixture business)

The real store had no business ready to run, so one fixture restaurant was added to the backed-up store for the session. It belongs to the same local owner and was built by the test fixture, so it's fictional and involved no AI. The store was then restored byte-for-byte.

| Scenario | Expected | Actual | Notes |
|---|---|---|---|
| Standard order | ALLOW, completed | ALLOW, completed | 12 steps; ₦42,780 to Lagos Fresh Foods (demo), "Test run — no transaction" |
| Large catering | WARN, waits | WARN, waits → approved → completed | Approval card: ₦56,580, threshold ₦50,000, maximum ₦250,000, 15-minute expiry |
| New supplier | WARN, waits | WARN `FIRST_INTERACTION` → declined | Mainland Grains (demo); no ledger row |
| Price spike | BLOCK | BLOCK `OVER_TX_LIMIT` | ₦263,500; no approval and no outcome |
| Quiet day | No reorder | No reorder | 6 steps |

**Controls:**
- Stop on a waiting run → `Cancelled`, "Stopped by you", approval removed.
- Kill switch → `Cancelled`, "Stopped by the kill switch"; the start is disabled, and the API refuses with `KILL_SWITCH_ACTIVE`. Switching it off re-enables runs.
- Agent pause → the run pauses before the Finance step; resuming the agent resumes the run.

**Layout and accessibility:**
- **Mobile:** 375 px with no horizontal overflow.
- **Contrast:** 150 text elements on the Runs page, including the approval card, pass WCAG AA in both the dark and the light theme.
- **Reduced motion:** the timeline reveal (`.enter`) and spinners are disabled under `prefers-reduced-motion`.

**Found and fixed during the browser checks:**
1. **The advance loop never started in development.** React StrictMode mounts twice, and the unmount flag was never reset, so no step ran. The flag is now set on every mount.
2. **System steps (trigger, condition, end) were mislabelled.** They read as "Security and approvals" hand-offs. They are now labelled "EmployAI runner (system)" with no hand-off arrow; the security check and approval steps keep "Security and approvals (system)".
3. **The page kept a stale view after the kill switch.** The page now adopts fresh server props after `router.refresh()`.

A dev server left running from before M4 served stale modules (the first start returned 500 and the header had no Runs tab). A clean restart fixed it. No code change was needed, but it's worth knowing for the demo.

## Deviations from the plan

All of these are minor, and none reduces security, recovery or concurrency:
1. **Response shapes:** responses carry `{ run, view, … }` rather than `{ view, … }`, a superset. Start returns `200` with `created`. The agent-pause route returns its view as `runs`. Doc 04 is updated.
2. **The approval card shows the expiry time, not a live countdown.** This is presentation only; the server enforces the expiry, and the card shows "Expired" once it passes.
3. **One reorder item per run** (the first item below its reorder point), as in the scenarios.
4. **The notify-step contracts are fixed in the runner** rather than configurable.
5. **The step timeout is checked after the step:** handlers are synchronous and bounded, so they can't be pre-empted.
6. **The daily limit counts today's simulated outcomes.** They still never count as prior payments (D7).
7. **The generated `security_check` step description changed** to "Test runs use fictional demo data; on-chain checks start in the next stage." This affects new drafts only; approved versions are unchanged.
8. **No lint run:** the project has no ESLint configuration.
9. **Expected vs actual uses different wording for WARN scenarios** ("Waits for your approval" vs the actual end, such as "Completed"). The decisions match; only the end wording differs.

## Known limitations

- **Single-process only:** the runner and JSON store aren't safe across processes or instances (stated, not claimed otherwise). Supabase stays unapproved.
- **Unexpected-error logs show only a correlation id.** That's the existing design: no business data goes into logs. Diagnosing a 500 needs a local reproduction.
- **Rule-based agents only:** there is no on-chain check, signer or real payment; all of those start in M5. The attack scenario and blocklist are M6.
- **Browser checks were manual,** in the in-app browser. Playwright still needs approval.

## Files

- **New:**
  - `src/lib/locks.ts`
  - `src/lib/runs/*` (types, repo, fingerprint, eligibility, scenarios, tools, agents, runner, view, view-types, routes)
  - `src/lib/security/*` (gate, authorisation)
  - 9 route files under `src/app/api/w/[id]/`
  - `src/app/w/[id]/runs/page.tsx`
  - `src/components/workspace/` (`RunsWorkspace`, `KillSwitchControl`, `runs-api`)
  - 4 test files and `tests/helpers/run-fixture.ts`
- **Changed:**
  - the store and services (shared lock, fingerprint on approval, paused status);
  - demo data v2;
  - the team route (agent pause);
  - `WorkspaceShell` (Runs tab, kill switch);
  - copy in Team, Workflows and the discovery notice;
  - docs 02, 03, 04, 05 and 08, and the decision log.
- **Not to commit:** `.claude/` and the root screenshot.
