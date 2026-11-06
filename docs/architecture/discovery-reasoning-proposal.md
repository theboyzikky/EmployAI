# Discovery consultant: diagnosis and improvement proposal

Status: **Diagnosis. The owner decided on 2026-11-06 to address it in a separate milestone, M3.5 · Discovery intelligence, between M3 and M4; phases P1–P4 below are its scope (see the [M3.5 proposal](m3.5-proposal.md), awaiting approval). Decision R2 is therefore settled: a separate milestone before M4.** No code has been changed and no AI provider was called. Date: 2026-11-06.

The owner tested the discovery conversation and found it records what is said instead of reasoning about it. This document explains why, from the actual implementation, and proposes how to fix it.

---

## 1 · What was tested, and what it actually did

The local server runs with `AI_PROVIDER=mock`, so the conversation you tested is the **offline, rule-based consultant** (the "Offline demo AI (rule-based)" badge). NEAR AI has never been called from the product.

I ran your example through the real offline code (a temporary probe, deleted afterwards). This is the **actual output**:

> **Owner:** I run a small restaurant called Mama Nkechi's Kitchen in Lagos. Our restaurant keeps losing money because we buy too much stock.
> **Recorded:** industry = Restaurant · business name = Mama Nkechi's Kitchen · **challenges = "Our restaurant keeps losing money"** (confirmed)
> **Consultant:** Thanks for the introduction. Here's what I've noted so far: … I'll ask a few short questions to fill in the gaps. **What's on the menu: your main dishes or products?**
>
> **Owner:** Jollof rice, fried rice and grilled chicken.
> **Consultant:** Noted: products & services, "Jollof rice, fried rice and grilled chicken". **How do customers order today: …?**
>
> **Owner:** I want to make more profit.
> **Recorded:** **how customers buy = "I want to make more profit"** (confirmed)
> **Consultant:** Noted: how customers buy, "I want to make more profit". …
>
> **Owner:** We have 4 staff.
> **Recorded:** **goals = "We have 4 staff"** (confirmed)
>
> **Owner:** Actually it's just me, I do everything myself.
> **Recorded:** **suppliers = "Actually it's just me, I do everything myself"** (confirmed)
> **Consultant:** Noted: suppliers, "Actually it's just me, I do everything myself". …

It's worse than note-taking:
- **The owner's causal claim is lost.** "We buy too much stock" is never recorded; only the symptom ("losing money") is kept.
- **Answers are filed under whatever was just asked,** even when they plainly answer something else, and are marked *confirmed*.
- **The contradiction ("4 staff" vs "just me") is never noticed.** The two statements land in unrelated fields.
- **The questions follow a fixed list per field.** They never react to what the owner revealed.
- **Wrong entries count as progress,** so the conversation looks closer to "ready" the more it misfiles.

## 2 · Root causes (from the code)

Making the prompt longer would not fix any of these: most are in the data model and the control flow, not the wording.

| # | Root cause | Where | Effect |
|---|---|---|---|
| RC1 | **The task is defined as form-filling.** The unit of understanding is one of 10 profile fields. Each turn's output is `{ facts → fields, question_field ∈ those 10 fields, reply }`. The prompt says "extract facts into these profile fields… ask about the most useful field that is still unknown" | `lib/ai/prompts.ts` (`DISCOVERY_SYSTEM`), `lib/discovery/merge.ts` (`DiscoveryTurnSchema`) | A question can only be "which field is empty?". There's no way to express "why", "how often", "which of these causes" or "that contradicts what you said" |
| RC2 | **Once a field has a value it's done forever.** `isKnown` = has a value. The next question skips known fields, and a question about a known field is *discarded by code* (`question_field` is nulled when the field is known) | `lib/discovery/profile.ts`, `lib/discovery/service.ts` (`consultantTurn`), `lib/rules/questions.ts` | Even a capable model can't dig into a problem the owner already mentioned. If it tries, the turn is recorded as an "insight" and readiness may declare the conversation finished while a question is still open |
| RC3 | **Readiness measures coverage, not understanding.** It's ready when the core fields are filled and 3 optional ones are "resolved", and a field asked once counts as resolved even if never answered | `readiness()` in `profile.ts` | The conversation is engineered to stop as soon as each box has *something* in it |
| RC4 | **No representation for claims, causes, hypotheses, open questions or contradictions.** The only state carried between turns is 10 strings plus `asked`. The reasoning of a live model isn't stored, so every turn starts again from a truncated transcript | `ProfileDoc` | Assumptions can't be tracked, investigated or resolved; nothing accumulates |
| RC5 | **Status words mean the wrong thing.** *Confirmed* = "the owner said it", even if it's the owner's own guess about a cause. *Assumed* = "the consultant inferred it" | `FieldStatusSchema`, prompt | "We buy too much stock" (a belief) would be stored with the same certainty as "we sell jollof rice" (a fact) |
| RC6 | **Merging silently overwrites.** A newer value replaces an older one, with no check for conflict | `mergeFacts()` | Contradictions are erased, not raised |
| RC7 | **The offline consultant is an extractor with a harmful fallback.** Regex rules plus a fixed question bank per business type. When a question is pending, **the whole reply is stored as the answer to that field** and marked confirmed. Sentences are split at "because", which throws away the causal link | `lib/rules/extract.ts` (`extractFromAnswer`, `clauses`), `lib/rules/consultant.ts`, `lib/rules/questions.ts` | Exactly the behaviour you saw |
| RC8 | **Downstream inherits the symptom, not the cause.** Analysis restates challenges as bottlenecks. The team proposal maps keywords ("stock") to capabilities. Nothing records that a cause is unverified | `lib/rules/analysis.ts`, `lib/discovery/analysis.ts`, `lib/catalogue/propose.ts` | Agents are proposed for "excess stock" whatever the real cause is, and are presented with the same confidence as facts |

**Would NEAR AI fix it?** Only partly. A live model would phrase things better, but RC1–RC6 still apply. It is asked to fill fields; any deeper question it asks about a filled field is thrown away; its reasoning isn't kept; and the conversation ends on coverage.

## 3 · Does the current architecture support reasoning?

| Capability | Today | What's reusable |
|---|---|---|
| Contextual understanding of meaning | ❌ Offline: keywords. Live: possible, but the output can only be field values | The one structured call per turn, zod validation, untrusted-text fencing |
| Assumption checking | ❌ No place to record a belief as unverified | Evidence-grounding (every item cites an owner message), done by code |
| Intelligent questioning | ❌ One question per field, fixed order | The "one question per turn" rule |
| Adapting to previous answers | ⚠️ Only cosmetic (quoting an earlier answer) | The transcript is available |
| Not repeating questions | ⚠️ Per field only; the same intent can come back reworded | `asked` tracking |
| Contradiction detection | ❌ Overwrites | Merge is centralised in code, so it can be added |
| Facts vs assumptions vs unknowns | ⚠️ Three statuses, but the wrong meanings (RC5) | The panel already shows statuses |
| Explaining reasoning | ❌ | — |
| Knowing when to move on | ⚠️ Coverage-based (RC3) | Readiness is decided by code, not the model, which is the right principle |
| Cost control | ✅ Approval flag, key, call cap, daily USD cap, worst-case reservation, no retries, no fallback | Kept unchanged |

The foundations are sound: code-enforced grounding, one call per turn, deterministic policy, offline-first, and spend guards. What's missing is **a model of the business problem** and **a question policy that works on it**.

## 4 · Proposed design: a consultant "case file" plus a code-owned question policy

**Principle:**
- **The model, or the offline rules, interprets language.**
- **Code owns the state and the policy:** what's confirmed, what's still a hypothesis, what to ask next, when to stop. The model can't mark its own hypothesis as fact, repeat a question, or end the conversation.

### 4.1 The case file (replaces the 10-field profile as the source of truth)

The 10 fields remain as a **derived view** for the summary, the team proposal and the UI, so M2/M3 consumers keep working.

| Element | Content | Statuses |
|---|---|---|
| **Facts** | Stable business facts (name, menu, channels, team size, tools, suppliers) as typed slots, so "4 staff" and "just me" are both values of `team.size` and conflict automatically | `confirmed` (owner stated or confirmed), `assumed` (consultant inference, shown as unconfirmed), `unknown`, `contradicted` |
| **Claims** | What the owner *believes or reports*, kept apart from verified facts: **symptoms** ("losing money"), **causal claims** ("because we buy too much stock"), **goals**, **constraints**. Each cites its message | `stated` (owner's view, not verified), `confirmed` (owner confirmed after being asked, or corroborated by other answers), `questioned` |
| **Problem tree** | Symptom → claimed cause → **candidate causes (hypotheses)**, e.g. overbuying → {stock expires before use, staff order without checking stock, demand overestimated, supplier delivers more than ordered, stock records inaccurate} | Hypotheses: `open`, `supported` (evidence for), `ruled_out` (evidence against), `confirmed` (the owner agrees). Code never moves a hypothesis to `confirmed` without the owner's words |
| **Agenda** | Open questions, each with its **purpose** (which fact, claim, hypothesis or contradiction it resolves), priority, times asked, and answer status | `open`, `answered`, `partly answered`, `declined`, `dropped` |
| **Contradictions** | Pairs of conflicting statements with their messages | `open`, `resolved` (with the owner's resolution) |
| **Reasoning notes** | Short, owner-visible lines explaining why something was asked or concluded, each linked to its evidence | — |

### 4.2 One turn (still **one** AI call in live mode; zero offline)

1. **Interpret** (model or offline rules). For the new message, relative to the open agenda item:
   - which question it answers (fully, partly or not)
   - new facts, claims (with type) and evidence
   - signals for or against open hypotheses
   - possible contradictions
   - 1–3 candidate next questions, each tagged with its purpose
2. **Update** (code):
   - Ground everything to real owner messages.
   - Put facts in their slots; a different value in the same slot opens a **contradiction**, never a silent overwrite (an explicit correction like "actually…" is resolved as a correction, but still flagged so the owner sees it).
   - Store beliefs as **claims**, never as facts.
   - Move hypotheses only on evidence.
   - Text that isn't understood is kept as an **unclassified note** and clarified. It's never stuffed into the pending field (this removes RC7's fallback).
3. **Choose the next question** (code, deterministic). Pick the first eligible item from:
   1. an open contradiction that matters
   2. a hypothesis on the main problem whose answer would **change the recommendation**
   3. a missing essential fact
   4. a nice-to-have detail

   Hard rules:
   - never re-ask an answered question or one with the same purpose (purpose fingerprints, not just field names)
   - at most 3 probes per problem
   - "I don't know" marks it **unknown** and moves on
   - the model's candidate wording is used only if its purpose matches the chosen agenda item; otherwise a template is used
4. **Reply** (template frame plus the chosen wording):
   - a one-line reflection of what was *understood*, not a field dump ("So the losses are tied to stock that's bought but not used")
   - a short reason when the question challenges an assumption ("Overbuying has several possible causes and each needs a different fix, so…")
   - **exactly one question**
5. **Readiness** (code). Move forward when:
   - the essentials are known
   - every main problem has an owner-confirmed or well-supported cause, **or** is explicitly marked "cause unknown — to be measured"
   - no material contradiction is open

   **Or** the question budget is reached (for example, 12 questions). In that case it moves on and lists the unknowns. The owner can always choose "Analyse now"; the unknowns are then carried forward and shown.

### 4.3 What the owner sees

The **"What I understand"** panel becomes three groups, each item clickable to its evidence:
- **Confirmed facts**
- **Your view — not yet verified** (claims and the possible causes being checked)
- **Still unknown**

It also shows **"To resolve"** items for contradictions and **"Why I'm asking"** on the current question. Same design system, ash secondary text, no new components beyond list variants.

### 4.4 Offline mode: diagnostic playbooks instead of a question bank

Offline mode can't understand open language, and it shouldn't pretend to. Instead of field-by-field questions, it uses **curated, deterministic diagnostic playbooks** for common small-business problems:
- **Restaurant first:** overbuying/waste, running out, missed orders, low profit or cash, slow service.
- **Then a shallower set** for retail and salon.

Each playbook defines the symptom patterns it recognises, its hypotheses, one diagnostic question per hypothesis, and simple answer classifiers (yes / no / sometimes / numbers / named causes). When nothing matches, it says so honestly and asks the owner to describe the problem in their own words. It stays labelled "Offline demo AI (rule-based)".

The playbooks are **data**, reviewed like the capability catalogue, and the same playbooks give a live model a structured starting point, so both modes reason over the same problem tree.

### 4.5 Live mode (NEAR AI): only after your approval

- **Prompt and schema v2:** an *interpretation* object, not field facts. The output is validated, grounded and policy-filtered as above.
- **The prompt sends the case file, not the whole transcript.** Recent messages plus a compact case-file summary keep the input small and stable.
- **Unchanged:** one call per turn, no retries, no fallback to offline in live mode, the explicit `NEAR_AI_CALLS_APPROVED` flag, call and daily USD caps, and worst-case reservation before each call.

## 5 · Example conversations (target behaviour)

The "current" examples are real output (§1). The "improved" examples show the **intended behaviour** of the design; they are not model output.

### A · An assumption about the cause

> **Owner:** Our restaurant keeps losing money because we buy too much stock.
>
> **Improved consultant:** I've noted that you're losing money, and that you think overbuying is behind it. Before we look at fixes, I'd like to understand *how* it happens, because overbuying has several causes and each needs a different solution. **When stock goes unused, what usually happens to it: does it spoil or expire before you can use it, or does it just pile up?**
> *Panel → Your view, not yet verified:* "Losing money" (symptom) · "Buying too much stock" (your view of the cause). *Being checked:* expiry/waste · ordering without checking stock · demand overestimated · supplier over-delivery · stock records inaccurate.
>
> **Owner:** Tomatoes and peppers go bad a lot. Rice is fine.
>
> **Improved:** So the loss is mostly fresh produce spoiling, not dry goods. That points to *how much* fresh produce is bought each time, rather than buying in general. **Who decides how much fresh produce to buy, and do they check what's left before buying?**
> *Hypotheses:* expiry/waste → **supported** (fresh produce) · inaccurate records → open · demand overestimated → open
>
> **Owner:** My cook buys at the market every morning, usually the same amount every day.
>
> **Improved:** Thanks, that's an important detail. Buying the same amount every day, whatever is left over, would explain fresh produce spoiling on quieter days. **Do sales change a lot between weekdays and weekends?**
> *Hypotheses:* ordering without checking stock → **supported** · demand overestimated → being checked
>
> **Owner:** Weekends are about double.
>
> **Improved:** That makes sense of it. With a fixed daily purchase, weekday quantities are probably too high and weekend quantities may run short. I'd treat this as the likely cause, but you'll be the judge: **does that match what you see, too much on weekdays and sometimes short on weekends?**
> *(If the owner agrees, the cause becomes **confirmed by owner**; if not, it stays **supported** and the panel says so.)*

### B · A contradiction

> **Owner (earlier):** We have 4 staff.
> **Owner (later):** Actually it's just me, I do everything myself.
>
> **Current (real):** "Noted: suppliers, 'Actually it's just me, I do everything myself'."
>
> **Improved:** Earlier you mentioned 4 staff, and now that you do everything yourself. I want to get this right because it changes how much an AI team should take on. **Is it just you now, or do the 4 staff help with some things, like cooking, while you handle orders and buying?**
> *Panel → To resolve:* team size: "4 staff" vs "just me".

### C · An answer that doesn't fit the question

> **Consultant:** How do customers order today?
> **Owner:** I want to make more profit.
>
> **Current (real):** stores "I want to make more profit" as *how customers buy*.
>
> **Improved:** Understood, more profit is the goal, and I've noted it as that. To see where profit is lost, it helps to know where sales come from. **Do most customers order at the counter, by phone or WhatsApp, or through delivery apps?**
> *(Goal recorded as a goal; the channel question stays open, asked once more with its purpose, then marked unknown if declined.)*

### D · Knowing when to move on

> **Improved, after the cause is confirmed and essentials are known:** I think I have a clear enough picture: losses come mainly from fresh produce bought in fixed daily amounts while demand varies by day. Two things are still unknown, and I've listed them rather than guessed: exact weekly spending on produce, and how stock is recorded today. **Shall I analyse the business now?**

## 6 · How the reasoning should change the analysis and the agents

| Today | Improved |
|---|---|
| Bottleneck: "Our restaurant keeps losing money" (restated) | Bottleneck as a chain: **symptom** (losing money) ← **cause, confirmed by owner** (fixed daily fresh-produce buying vs variable demand) ← evidence (3 answers cited) |
| Opportunities from keywords ("stock" → inventory) | Opportunities only for **confirmed or supported causes**. Open hypotheses become **"measure first"** recommendations (for example, log spoilage for two weeks) instead of confident automation |
| Every item looks equally certain | Each item carries its basis: *owner-confirmed*, *supported by your answers*, *possible, not verified* |
| Agents chosen per keyword, with generic tasks | **Agents follow the causes.** Examples:<br>• Spoilage plus fixed buying → **Inventory Agent** tracks perishables and suggests daily quantities by weekday, and the **Procurement Agent** proposes market quantities from those numbers.<br>• Supplier over-delivery → **Procurement** checks deliveries against orders, and **Finance** requests payment only for what was received.<br>• Inaccurate records → **Inventory** starts with stock counts before any automation.<br>• An unverified cause → no agent is justified by it; it appears under "To verify". |
| Team reasons cite field text | Team reasons cite the confirmed cause and the owner's own words, and flag anything assumed |

**This stays within the five-agent architecture and the existing catalogue.** Some cause-specific tasks may need new **task entries** in the catalogue: perishable tracking, weekday quantities, checking deliveries against orders. Those are reviewed data additions; M3's workflow template is unaffected unless we choose to use them.

## 7 · Implementation plan, cost and risks

**Phases.** Each is independently testable and none needs AI calls.

| Phase | Scope | Estimate |
|---|---|---|
| P1 · Stop the harm (quick) | Remove the "file the whole answer under the pending field" fallback; keep causal clauses; treat a known field as probe-able; flag (don't overwrite) conflicting values; an unanswered question no longer counts as resolved | ~0.5 day |
| P2 · Case file | Facts as typed slots, claims, problem tree, agenda, contradictions; migration for existing conversations (old profiles convert to facts); the 10-field view derived for M2/M3 consumers; panel update | ~1–1.5 days |
| P3 · Offline diagnostic playbooks | Restaurant: 5 problem playbooks with hypotheses, questions and classifiers; retail and salon: lighter; honest fallback | ~1 day |
| P4 · Analysis and team proposal | Cause chains, a basis on every item, "measure first" items, cause-driven agent reasons and task suggestions | ~0.5–1 day |
| P5 · Live mode v2 (optional, after approval) | Interpretation schema, compact case-file prompt, policy filtering, tests against a local fake server (no real calls) | ~1 day |

**Total: ~3–4 days for P1–P4** (offline, no AI), plus ~1 day for P5.

**Schedule impact.** The deadline is Nov 14, and M4 is planned for Nov 9. Doing P1–P4 before M4 would push M4 to about Nov 10–11 and compress M5 and M6. Options:
- **(a)** P1 now (half a day), then M4, then P2–P4 alongside M5 or M7.
- **(b)** P1–P4 now, then M4 with a tighter M5.
- **(c)** Defer everything except P1.

My recommendation is **(b)**, if the business-consultant experience is the product's core claim, which your feedback suggests it is.

**AI cost (only if you approve live mode).**
- **Per turn:** one call, no retries. With a compact case file, a turn is about 2.5k input and 600 output tokens. At the PoC-A prices (catalogue prices checked before every call):

| Model | Cost per turn | Cost per full discovery (≈ 12 turns + analysis) |
|---|---|---|
| Qwen 3.8 27B | ≈ $0.0009 | ≈ $0.012 |
| Haiku 5.5 | ≈ $0.0006 | ≈ $0.008 |

- **Optional quality evaluation:** about 10 scripted conversations × 8 turns = 80 calls, ≈ $0.05–0.07, under a hard cap you set (for example, $0.10). It needs your explicit approval and would be reported like PoC-A. Nothing in P1–P4 needs it.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Over-questioning annoys the owner | 3 probes per problem, about 12 questions in total, "skip" and "Analyse now" always available |
| Leading questions or invented causes | Hypotheses come from reviewed playbooks (offline) or are policy-filtered; they're always shown as possibilities; only the owner's words can confirm them |
| Contradiction false alarms (an honest correction) | "Actually…" is treated as a correction and resolved immediately but still shown; only material slots raise a question |
| Offline mode covers only known problems | Honest "I don't recognise that; tell me more" fallback; labelled as rule-based; live mode for open-ended understanding (with approval) |
| Migration breaks M2 or M3 behaviour | The derived 10-field view keeps existing consumers; the existing 74 tests plus new tests (contradictions, no-repeat, readiness, playbooks, misfiled answers, causal clauses) |
| Prompt injection via owner text | Unchanged fencing; the model only proposes interpretations; code owns state and policy; questions never trigger actions |
| Model quality varies (live) | Code-owned policy limits the impact; evaluation before relying on it |
| Schedule | Phasing above; P1 alone removes the worst behaviour |

## 8 · Decisions for you

| # | Decision | Recommendation |
|---|---|---|
| R1 | Adopt the case-file model and code-owned question policy | **Yes** |
| R2 | Ordering versus M4: (a), (b) or (c) above | **(b)** P1–P4 before M4 |
| R3 | Offline diagnostic playbooks: restaurant in depth, retail and salon lighter | **Yes** |
| R4 | Live mode v2 (P5) built and tested against a local fake server only | **Yes**, no real calls |
| R5 | Optional paid evaluation of live mode (≈ $0.07, hard cap $0.10) | **Later, only with your separate approval** |
| R6 | New cause-specific agent tasks in the catalogue (reviewed data; M3 template unaffected) | **Yes**, as needed by P4 |
