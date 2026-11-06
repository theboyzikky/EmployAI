# M3 report · Workflow generation, validation and approval

Date: **2026-11-06**. Approved scope: the M3 plan with decisions D1, D2, D4, D6, D7 and D8, plus the owner's changes 1–6 (see the [decision log](../README.md#decision-log-owner-decisions)).

Constraints honoured:
- **No AI calls** (D8). Workflows come from fixed templates; `.env` was not touched (`AI_PROVIDER=mock`, set explicitly).
- No new dependencies, no paid services, no accounts created or funded, no contract deployed, nothing pushed.
- **Nothing executes.** M3 approves workflows; it does not run them. Test runs arrive in M4.
- Local development store continued (D6). Not production persistence.
- **No commit.**

## What was built

| Area | What the owner sees | How it works |
|---|---|---|
| Workspace `/w/[id]` (D2) | Two tabs, **Team** and **Workflows**. `/w/[id]` opens Workflows. Back arrow to discovery. Nothing else from the future dashboard is shown. | Server pages behind `<Suspense>` with the owner check (`getOwnedBusiness`); anyone else gets a 404. |
| Team tab | A read-only view of the approved team: tasks (switched-off ones struck through), money permissions, and an "Approved · not running" or "Approved · Preview" badge. | `buildWorkspaceView`. |
| Build workflow | "Build the workflow for your team", with the not-running notice and a **Build workflow** button. | `POST …/workflows/generate`: a deterministic template (`generateRestaurantWorkflow`) that uses only approved, executable agents and the tasks the owner kept on. Steps that can't be built are listed with the reason, for example *"No payment steps: the Finance Agent isn't on the approved team…"*. |
| Steps | **Diagram** (tablet and desktop) with a sticky detail panel, or an accessible numbered **List** (the default on phones), with the detail expanding inline. Steps that guard the payment have a violet outline. | `layoutWorkflow`: a grid with the main line in column 0 and branches beside it; SVG edges with outcome labels (*yes / no*, *ALLOW / WARN*, *BLOCK*, *approved / declined*). |
| Step detail | Who does it, the task, inputs and outputs, tools, data read and written, what happens next (clickable), and *"Described only — test runs start in the next stage"*. | `StepDetail`. |
| Payment step (change 5) | Two separate boxes. **Who gets paid · beneficiary**: the approved supplier from the Procurement step. **How it's requested · channel**: a `request_payment` call to the treasury contract on NEAR testnet, "never the recipient". Amount in illustrative naira, test run only. | Schema: `beneficiary {kind: "approved_supplier", from_step}` is separate from `channel {kind: "treasury_contract", method: "request_payment", network: "near-testnet", contract_account: null}`; `amount {currency: "NGN", illustrative: true}`; `mode: "test_run"`. |
| Settings (change 1) | "Ask me before paying more than ₦…", "Maximum per payment ₦…", and two notification switches, with the note *"Illustrative amounts in Nigerian naira… NEAR contract limits and network fees are set separately in a later stage (M5). Nothing is converted between currencies."* | `PATCH …/workflows/:wid`, the only editable fields. A draft is rebuilt and re-checked. On an approved version, the button reads "Save as new draft" and creates the next version. |
| Safety checks | "All 15 checks passed", or the failures first with their reasons. | `validateWorkflow` (below). |
| Approve (change 4, D7) | **Approve workflow**, then a confirmation: *"Approve version N? Your approval is recorded with a timestamp. Approving doesn't run anything…"*. Disabled when any check fails. | `POST …/workflows/:wid/approve` re-validates against the **current** team; if invalid, it returns `409 WORKFLOW_INVALID` and saves the result. Approving supersedes the previously approved version. |
| Versions | Version list with Draft / Approved / Superseded badges; any version can be opened read-only. Discard draft. Rebuild as new draft. | Status `draft` → `approved` → `superseded`. A replaced draft reuses its number. Approved versions are never deleted. |
| Demo data (change 3, D4) | A "Restaurant demo data · Demo data · fictional" card: menu, stock (low items flagged) and suppliers (one marked *"Not approved: can never be paid"*). | `scenario_data` on the business (approved column), set on first build, never written into the business profile. All supplier names end in "(demo)". |
| Preview (change 2) | Non-restaurant businesses: "Workflows are in Preview for this business". Agents carry "Preview — not executable in this prototype" in discovery and "Approved · Preview" in the workspace. | `isRunnableIndustry`: only "Restaurant / food service" is runnable; `generate` returns `409 PREVIEW_ONLY`. |

### The restaurant workflow (full team, defaults)

15 steps, 6 execution paths:

`trigger` → Order Agent checks the order → order confirmation to the customer → Inventory Agent updates stock → **Is anything below its reorder point?** (no → *No reorder needed*) → Procurement Agent recommends a supplier → Finance Agent prepares the payment request → **Security check** (BLOCK → *Payment blocked*) → **Your approval when needed** (declined → *You declined the payment*) → **Payment request through the treasury contract** → summary for you → *Done*.

Variants are built automatically, for example: no Finance Agent ends at *"Done: reorder handed to you"*; no Order Agent starts from a demo stock check; no Orchestrator gives an owner summary with no agent.

### Validator (change 6)

Every check runs when a workflow is built or changed, and again at approval against the team as it is then.

| Code | Rule |
|---|---|
| `SCHEMA` | Only the 8 step types and their fields (strict); at most 25 steps; payment channel, beneficiary kind, currency and mode fixed by the schema |
| `RUNNABLE_SCENARIO` | Restaurant demo only |
| `STEP_LIMIT`, `UNIQUE_IDS`, `SINGLE_TRIGGER` | Structure |
| `ROUTES_COMPLETE` | Every outcome of every step is routed to an existing step, with no unknown outcomes |
| `NO_CYCLES`, `ALL_REACHABLE`, `ALL_PATHS_END` | No loops; nothing orphaned; every path ends at an `end` step |
| `AGENTS_APPROVED`, `TASKS_ENABLED`, `TOOLS_ALLOWED` | Agents approved and runnable; tasks switched on; tools only from the agent's catalogue entry |
| `PAYMENT_BENEFICIARY_AND_CHANNEL` | The beneficiary comes from a Procurement step; the Finance Agent requests through the treasury contract; test run only |
| `PAYMENT_PATHS_GUARDED` | On **every** path to a payment: its security check comes first and continues with ALLOW or WARN; its approval check comes *after* that security check and continues with "approved"; the supplier step is on the path |
| `SETTINGS_VALID` | Ranges, and the approval threshold not above the maximum payment |

## Tests performed

| Check | Result |
|---|---|
| Unit tests (`tests/workflows.test.ts`, 20) | Pass. They cover generation for the full team; no Finance, Inventory, Procurement, Order or Orchestrator; the confirm task off; preview agents; and determinism. Each validator rule has a failure case: loop, orphan step, missing, unknown or dangling route, duplicate ID, two triggers, more than 25 steps, unknown step type, extra field, tampered contract account, channel, currency, beneficiary kind or payment agent, beneficiary not from Procurement, no security check, BLOCK reaching payment, approval skipped, decline reaching payment, wrong security subject, approval before the security check, removed, preview or disabled-task agents, disallowed tools, out-of-range settings, threshold above maximum, non-runnable business, garbage input. Layout and demo-data labelling are also covered. |
| Route tests (`tests/workflow-routes.test.ts`, 7) | Pass. They cover: owner-only access (404 with nothing leaked, cross-origin 403); `TEAM_NOT_APPROVED`; salon `PREVIEW_ONLY` (no demo data); and the full lifecycle (generate, regenerate replaces the draft, settings rejected with 400, valid change rebuilds in place, approve, approve again 409, discard approved 409, edit approved creates v2, approve v2 supersedes v1, superseded can't be edited, rebuild v3 from the approved settings, discard v3). A tampered stored draft (BLOCK → approval) is refused with `WORKFLOW_INVALID` and stays a draft. A team change after building is caught at approval. There is no `/deploy` route. No `fetch` was called. |
| Full suite | **71 / 71 pass** (44 from M2 plus 27 new). |
| `tsc --noEmit` | Clean. |
| `next build` | Passes. `/w/[id]`, `/w/[id]/team` and `/w/[id]/workflows` are partially prerendered; the 5 workflow API routes are dynamic. |
| Browser, restaurant journey | Discovery (offline consultant) → approve team → "Build workflows" link → Build workflow (v1 draft, 15 / 15 checks) → payment and security detail → threshold above maximum blocked in the form → save 75 000 → approve → edit maximum on the approved version → v2 draft → approve v2 → v1 superseded. |
| Browser, layouts and themes | Desktop 1440 (diagram + sticky detail) and mobile 375 (list with inline detail). **No horizontal overflow.** Contrast audit, WCAG AA, every visible text node: 0 failures in dark and light at both widths, after one fix (below). |
| Browser, Preview and gates | Salon: Workflows shows the Preview state and Team shows "Approved · Preview". Before team approval, Workflows shows "Approve your team first". |
| Re-run after the review changes (2026-11-06) | **71 / 71 tests pass**; `tsc` clean; `next build` passes. Landing page at 1440 px: the hero subtitle is 3 lines, and the "Build, validate and approve workflows" title wraps to 2 lines with the four cards still equal height. At 375 px: the subtitle is 5 lines, both hero buttons stay above the fold, and there is no horizontal overflow. Contrast of the changed text, WCAG AA: hero 9.68:1 dark and 6.51:1 light; card body 8.71:1 dark and 6.69:1 light. No styles changed. |

Fixes made during testing:
- A rebuilt draft was numbered "Version 2" although version 1 had never been approved. A replaced draft now keeps its number.
- The green "Approved" badge measured 4.46:1 on the selected version row in light mode. It now has its own surface (passes).
- Shorter step labels (the agent's name only) so long names don't wrap in diagram nodes. The detail header is hidden in the list, where the row already shows it.

## Changes to completed milestones (for your review)

These are small, approved-scope touches to M2 code:

1. **Preview labelling (change 2).** Discovery's view marks an agent executable only if its catalogue entry is executable **and** the business is the restaurant demo. A salon's Bookings Agent now shows "Preview — not executable in this prototype" (before, it showed as executable). The view gains `runnable`.
2. **Approval wording (change 4).** The team approval message and confirmation text in discovery no longer say "deployed"; they say "Nothing runs…" and point to building workflows.
3. **Link to the workspace.** After team approval, discovery shows **Build workflows** (restaurant) or **View team workspace** (Preview).
4. `ownerRoute` takes an optional `errorView`, so workflow errors return the workspace view. Discovery routes are unchanged.
5. The dev store gains `scenario_data` on businesses and a `workflows` table with list, create, update and delete.
6. 9 icons were added to the central registry from the existing Phosphor package (Bell, GitBranch, Flag, FlowArrow, ListBullets, Database, ArrowsClockwise, Trash, ArrowBendDownRight).

## Documentation corrections (approved terminology)

- `00` (journey step 5 "Generate and approve workflows")
- `02` (validator on every path, beneficiary vs channel, **Approve** instead of Deploy, Diagram 3 states `Approved` / `Superseded`)
- `03` (`workflows.status` `draft`/`approved`/`superseded`, `approved_at`; `scenario_data` labelled fictional)
- `04` (approve, PATCH and discard endpoints; no `/deploy`)
- `05` (T5 path-based check; "Editing an approved workflow")
- `08` (M3 and M4 rows)
- README decision-log entry

## Decisions (accepted by the owner, 2026-11-06)

1. **`WORKFLOW_INVALID` is `409`, not `400`.** The request is valid; it's the stored workflow that can't be approved. It sits with `STATE_CONFLICT`, `TEAM_NOT_APPROVED` and `PREVIEW_ONLY` (`04` updated).
2. **Generate returns `200 { view }`, not `202`.** Generation is synchronous and deterministic (no AI), so there's nothing to poll (`04` updated).
3. **Payment approval rule.** This is the intended future execution behaviour (M4/M5), not an executable feature in M3:
   - Every payment path contains a security check followed by an owner approval control. The validator enforces this on every path (`PAYMENT_PATHS_GUARDED`).
   - Manual owner approval is required when the amount **exceeds** the configured threshold, or when the security gate returns **WARN**.
   - An **ALLOW** result at or below the threshold needs no additional manual approval.

   This is recorded in the decision log. The approval step's detail now says it in the same words: *"When the amount is above ₦… (illustrative), or the security check returns WARN. A payment the security check allows at or below that amount needs no extra approval from you."*

## Review changes (2026-11-06)

| Change | Where |
|---|---|
| "How it works" step 4: **"Build, test and deploy"** → **"Build, validate and approve workflows"**. Its body also claimed deployment (*"…and deploys only what you approve"*), so it now reads *"EmployAI generates the workflows and checks every step, then waits for your approval."* | `src/components/landing/HowItWorks.tsx` |
| Hero: *"…let AI design, build and safely deploy specialised agents — …"* → *"…let AI design specialised agents and build checked workflows for your approval — while you stay in control of every rule, payment and permission."* | `src/components/landing/Hero.tsx` |
| Approval step detail aligned with decision 3 | `src/components/workspace/StepDetail.tsx` |
| Judge step 10 in the root README: *"deploy the generated workflow"* → *"approve the generated workflow"*. It was missed in the first terminology pass. | `README.md` |
| Decision-log entry for these decisions | `docs/architecture/README.md` |

No styles, layout or behaviour changed. The checks were re-run after these edits (see "Tests performed").

## Visual review fixes (2026-11-06)

The owner's six visual-review issues. M3 scope is unchanged, no dependencies were added, and the design system is unchanged (existing tokens, components and the Phosphor icon set).

| # | Issue | Fix | Where |
|---|---|---|---|
| 1 | Two error messages when approval was refused | One panel. On a refusal it reads *"Approval refused: when this draft was re-checked, 3 of 15 safety checks failed."* (announced to screen readers), then lists the failed checks by name and links to "See why in Safety checks". On later visits it reads *"This draft can't be approved: …"*. The server's generic message is no longer shown for `WORKFLOW_INVALID`; other errors are unchanged. | `WorkflowWorkspace.tsx` (`ApprovalBlocked`) |
| 2 | Mobile list mixed branches and dead ends into the main sequence | The list now follows the **main sequence, numbered in execution order**. A step reached through a labelled outcome shows it (*If yes*, *If ALLOW / WARN*, *If approved*). Branches sit indented under the step they leave from (*Branch: if BLOCK*), marked **Ends here** or *Then continues at step N*. The same list is used on desktop in List mode. | `StepList.tsx`, `lib/workflows/structure.ts` |
| 3 | An unreachable step was unclear | A shared helper finds steps nothing leads to and, for the template's end steps, the outcome that should lead there. Diagram: the step is drawn beside that source with a dashed danger outline, a **Not connected** label and a dotted *"BLOCK expected"* connector. Detail: *"Not connected. Nothing leads to "Payment blocked". It normally follows the BLOCK outcome of "Security check on the payment", which now goes to "Your approval when needed"."* The source step's BLOCK outcome says *"Should lead to "Payment blocked", which is now disconnected."* List: a separate **Not connected** section. The validator's `ALL_REACHABLE` check gives the same explanation. | `structure.ts`, `validate.ts`, `layout.ts` (optional anchors), `WorkflowDiagram.tsx`, `StepDetail.tsx`, `StepList.tsx` |
| 4 | Payment and security details cut off on short desktop screens | The detail panel is limited to the window height and scrolls on its own (it can also be focused for keyboard scrolling), so every line is reachable without losing the diagram. The payment detail now leads with four boxed facts: **beneficiary**, **treasury channel**, **payment authority** (*"The Finance Agent can only request this payment. It can't send funds directly, choose a different recipient or hold a wallet key."*) and **security conditions** (the security check, then the approval rule, above the threshold or after a WARN). The security detail adds what it guards and what it checks (limits and the approved-supplier list). | `WorkflowWorkspace.tsx`, `StepDetail.tsx` |
| 5 | Business-name fallback | The placeholder is now a muted *"Business name not identified yet"*, which can't be mistaken for a name. The browser's Back button restored the cached page with the old placeholder even after discovery had found the name, so while no name is known the header re-checks it each time it is shown or the tab becomes visible. Verified: start a business, open Workflows (placeholder), open discovery (the first reply identifies "Suya Spot"), press Back, and the header shows "Suya Spot". No extra requests once a name is known. | `BusinessName.tsx`, `WorkspaceShell.tsx` |
| 6 | Wrapped step names in "What happens next" were centred | Each outcome is now a label line (outcome and meaning) followed by an arrow and the step name, left-aligned. A wrapped name stays aligned under itself. | `StepDetail.tsx` |

Checks after the fixes:
- **74 / 74 tests pass** (3 new: the main sequence and branches, the rerouted-BLOCK explanation with its anchored layout position, and the generic explanation).
- `tsc` is clean, `next build` passes, and `git diff --check` is clean.
- Browser: desktop 1024×640 and mobile 375×812, in dark and light, with no horizontal overflow.
- Contrast, WCAG AA, with the new elements visible: 0 failures (desktop and mobile, both themes). One run showed failures because the browser pane was hidden mid-run, which paused the theme transitions; the settled colours pass.

**Dev store restored.** The review used three temporary businesses. One had its stored draft deliberately edited (BLOCK routed into the approval step, and a `send_money` tool added to the Order Agent) to show the blocked states. The store was restored from the backup taken before the edit, and that business was removed from every collection. Checked before restoring: no other data had changed since the backup. Checked after: no temporary business or edited workflow remains; the main restaurant is back to version 2 Approved and version 1 Superseded (41 businesses); and the removed business returns 404.

## Sub-text colour and line spacing (2026-11-06)

The owner asked for secondary text (descriptions under a title, details, captions, evidence, field values) to be a clear ash, lighter in light mode and darker in dark mode, with moderate line spacing. This is applied across the whole app (landing page, discovery and workspace) through the existing design token, so every one of the ~130 secondary-text uses follows it.

| | Before | After |
|---|---|---|
| Light mode `--eai-muted` | Primary black at 64 % (≈ #5c5c5c) | Primary black at **58 %** (≈ #6b6b6b, lighter ash) |
| Dark mode `--eai-muted` | Black 400 (#b0b0b0) | Black 400 mixed **80 %** into Primary black (≈ #8d8d8d, darker ash) |
| Small text line spacing | 1.33 (xs) / 1.43 (sm) | **1.5** for both (Tailwind theme `--text-xs--line-height`, `--text-sm--line-height`) |

Notes:
- **Palette.** Both colours stay inside the approved palette, using the same method as the existing surfaces: Primary black at an opacity, or Black 400 mixed into Primary black. No hue is added.
- **Contrast.** Worked out before choosing, against every surface secondary text sits on. Light: at least 4.91:1 (white, page background, violet 100, violet 200). Dark: at least 4.82:1 (black, both dark surfaces, violet 900, violet 800). All are WCAG AA.
- **Secondary text that used the main colour now uses ash:** failed safety-check details (the example the owner marked), the line under "Not connected", and each disconnected step's explanation. Body content, callouts, warnings and table values keep the main colour, so the hierarchy holds.
- **Explicitly tight spacing on secondary text** (1.375, "snug") changed to 1.5: discovery evidence lines, analysis details, "What I understand" values, and the landing-page workflow, agent and film detail lines. Headings keep their tighter spacing.
- **Diagram lines** also use this colour. Their opacity went from 0.7 / 0.6 to 0.9 / 0.8, so solid and dashed lines are now more visible than before (dashed ≈ 3.6:1 light, 4.1:1 dark).

Checked:
- **Contrast:** every visible text node, WCAG AA, both themes, 0 failures. Pages: landing (160 nodes desktop, 170 mobile), discovery with the team proposal (302), Team tab (53), Workflows with a failing draft (146 desktop, 167 mobile, steps expanded), the approved workflow (143) and `/start` (17).
- **Layout:** no horizontal overflow. The film's detail lines stay single-line.
- **Builds:** 74 / 74 tests pass, `tsc` is clean, `next build` passes, and `git diff --check` is clean.
- **Dev store:** a temporary business with the same deliberately edited draft was used to show the failed-check area, then removed by restoring the store from a backup taken just before. Only that business had changed.

## Known limitations

- Local development store only (D6). Supabase and RLS are still to come.
- One template ("Order to restock"). Steps, agents, tools and payee rules can't be edited; only the four settings can.
- The diagram is laid out for this template's shape (a main line with side exits). Other shapes use a simple fallback route.
- A disconnected step's *expected* connection is known only for the template's end steps (blocked, declined, no reorder). Any other disconnected step gets the generic explanation *"Nothing leads to …, so it can never run."*
- The business name in the header is hidden on phones, as before.

## Files

New:
- `src/lib/workflows/` — `schema.ts`, `demo-data.ts`, `generate.ts`, `validate.ts`, `service.ts`, `view.ts`, `view-types.ts`, `layout.ts`, `structure.ts`
- `src/app/api/w/[id]/workflows/` — `route.ts` (GET), `generate/route.ts`, `[wid]/route.ts` (PATCH), `[wid]/approve/route.ts`, `[wid]/discard/route.ts`
- `src/app/w/[id]/` — `page.tsx`, `team/page.tsx`, `workflows/page.tsx`
- `src/components/workspace/` — `WorkspaceShell`, `TeamOverview`, `WorkflowWorkspace`, `WorkflowDiagram`, `StepDetail`, `WorkflowSettings`, `WorkflowPanels`, `StepList`, `BusinessName`, `step-meta`, `workspace-api`
- `tests/workflows.test.ts`, `tests/workflow-routes.test.ts`

Modified: `src/lib/discovery/{store,routes,service,view,view-types}.ts`, `src/components/onboarding/{TeamProposal,DiscoveryWorkspace}.tsx`, `src/components/icons/index.ts`, and the architecture documents listed above.

## Proposed next step (needs your approval; nothing is scheduled)

M4 · test runs and collaboration: an in-process runner for the **approved** workflow, "Run demo order" against the demo data, the live collaboration timeline, and the payment step in `test_run` mode with a simulated, labelled security gate.
