# EmployAI

> Status: **M1 done — landing page and onboarding handoff.** The marketing site and the hand-off into the business-discovery screen work. The AI consultant (NEAR AI Cloud), agents, workflows, security gate and NEAR testnet treasury are **not built yet**. Architecture, track mapping and plan: [docs/architecture/](docs/architecture/README.md). Steps marked _(planned)_ are not implemented.

## What it is

EmployAI is a hackathon prototype of an AI-powered Autonomous Business Builder. A small-business owner describes their business in plain language. An AI consultant asks follow-up questions, proposes a team of specialised AI agents, and generates workflows for them that run only after the owner approves. A deterministic security gate checks every payment before it is signed. NEAR testnet provides the Finance Agent's own account, a policy-enforcing treasury contract and a public ledger.

The end-to-end demo is a fictional restaurant/café. The Business Orchestrator coordinates the Order, Inventory, Procurement and Finance agents on each demo order. All demo data is fictional and labelled. Other business types get a proposed team too, and anything not executable in this prototype is labelled "Preview".

EmployAI's AI runs on **NEAR AI Cloud** (Qwen for structured discovery, Claude Haiku for agent tool calls). Choosing agents, security decisions and payment checks are deterministic code, not AI. For development and tests there is a clearly labelled **offline mode** with rule-based responses and no API calls. Every AI screen shows which mode is active, and a NEAR AI failure is reported as "AI unavailable", never silently replaced by offline mode.

## The problem

Small-business owners know what they want automated but not how to design triggers, workflows and agents. Giving AI agents access to tools and money adds risk: wrong actions, prompt injection, overspending and unsafe recipients.

## NEAR HACKATHON tracks targeted

- `business` — Autonomous Business (**primary**)
- `security` — AI Security & Defense (**secondary**)

A track is dropped from the submission if its required demonstration is not completed. EmployAI does **not** target AI Swarms (`swarms`). Its agents collaborate inside one business, which is not a swarm market.

## Prerequisites

Versions used to build EmployAI on Windows 11, checked 2026-11-04. Newer patch versions should work.

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 26.13.0 (Next.js needs ≥ 20.9) | Web app |
| npm | 12.0.1 | Package manager |
| Git | 2.56.0 | Source control |
| Rust (`rustc` / `cargo`) | 1.99.1, target `wasm32-unknown-unknown` | NEAR smart contracts |
| `cargo-near` | 0.22.0 | Building and deploying contracts |
| `near-cli-rs` (`near`) | 0.30.1 | Testnet accounts and keys |

Check them: `node -v`, `npm -v`, `git --version`, `rustc --version`, `cargo near --version`, `near --version`.

## Try it

1. Do: clone the repo, run `npm install`, copy `.env.example` to `.env` and set `AI_PROVIDER=mock`. See: dependencies installed. No API keys are needed: `mock` is the offline, rule-based consultant (labelled "Offline demo AI" on screen). `AI_PROVIDER` has no default; the app refuses to run discovery until it is set, and it never falls back from NEAR AI to mock.
2. Do: run `npm run build` then `npm start`, and open http://localhost:3000. See: the EmployAI landing page — navbar, hero with the business chat, How it works, AI workforce, workflow illustration, Security, Integrations, FAQs, final call to action and footer.
3. Do: scroll the page without typing anything. See: every section works on its own; the hero chat is optional.
4. Do: click **Restaurant** under "Try an example", edit the text if you like, and press Enter. See: you land on the business-discovery screen with your exact description already in the conversation (you are never asked to type it again), marked "Saved".
5. Do: open that discovery URL in a different browser. See: "We couldn't find that page" — a conversation is visible only to the browser that started it.
6. Do: answer the consultant's questions (or say "skip"). See: one focused question at a time, never one you've already answered; the "What I understand" panel fills in, each item marked Confirmed or Unconfirmed; after a few answers, "Analyse my business" appears.
7. Do: click **Analyse my business**, correct anything in the summary, then **Confirm summary**. See: processes, repetitive work, bottlenecks and automation opportunities, each with the answer it is based on; then the proposed team — for a restaurant, the Business Orchestrator plus Order, Inventory, Procurement and Finance agents. Remove an agent or switch off a task, then **Approve team**. See: approval recorded with a timestamp; **nothing runs, pays or contacts anyone** (workflows come next).
8. Do: describe a hair salon instead. See: a smaller team (a Bookings Agent labelled "Preview — not executable in this prototype"), because agents are only proposed for what you actually said.
9. Do: run `npm test`. See: 44 tests pass (rules, grounding, team rules, provider safeguards against a local fake server, route ownership/validation, prompt injection), with all network access blocked.
10. Do: deploy the generated workflow and click "Run demo order". See: _(planned — live agent handoffs, a security decision, testnet transactions on the public ledger, and the measured sale-to-payout time)_
11. Do: run `npm run demo:attack`. See: _(planned — injected instruction, BLOCK decision with reasons, no transaction hash)_

## What is live, testnet, simulated

| Feature | Mode |
| --- | --- |
| Landing page, hero chat, discovery hand-off | **Live** (local app) |
| Discovery session storage | **Local development store** (`.data/dev-store.json`, git-ignored). **Not production persistence**: one machine, no backups, no row-level security. Replaced by Supabase (approved design) when the project is created. |
| AI consultant | **Offline demo AI** (`AI_PROVIDER=mock`, rule-based) in development and tests. The NEAR AI Cloud adapter is built and tested against a local fake server only; **no live NEAR AI calls have been made in M2**. The screen always shows which mode is active. |
| Business analysis and team proposal | **Live** (local app). The team is chosen by deterministic rules from a capability catalogue. Agents are proposals only: none is active. |
| Workflows, agent execution, security gate | _Planned (M3–M6)_ |
| NEAR testnet treasury and ledger | _Planned (M5)_ — no testnet transactions exist yet |
| Workflow section on the landing page | **Illustration** (labelled), not live data |

## Libraries and baseline (HACKATHON.md Q-005)

- NEAR agent skills from [near/agent-skills](https://github.com/near/agent-skills): see [NEAR agent skills (development tools)](#near-agent-skills-development-tools) below.
- App: Next.js 16.4.5 (App Router, Turbopack), React 19.3, TypeScript 5.9, Tailwind CSS 4.3, Phosphor Icons 2.1.10 (`@phosphor-icons/react`), zod 4.6, Manrope (Google Fonts via `next/font`, self-hosted at build).
- No pre-hackathon code. Project started 2026-11-03.

## NEAR agent skills (development tools)

EmployAI is built with the official NEAR agent skills from https://github.com/near/agent-skills. They are instructions for the AI coding assistant (Claude Code) — guidance on NEAR contracts, accounts, keys, AI Cloud and Intents. They are not part of the EmployAI application and the app does not need them to run.

The skills are **installed locally and are not redistributed with EmployAI**. `.claude/skills/` is git-ignored, and EmployAI's MIT licence does not cover them. `skills-lock.json` is committed so the same 8 skills (upstream commit `cb32b6a`) can be reinstalled.

1. Do: run `npx skills add near/agent-skills` in the project root. See: 8 skills installed — `near-ai-cloud`, `near-api-js`, `near-cli-rs`, `near-contract-audit`, `near-dapp`, `near-intents`, `near-kit`, `near-smart-contracts`.
2. Do: when the installer asks, choose Claude Code as the agent (non-interactive: `npx skills add near/agent-skills --skill '*' --agent claude-code --copy -y`). See: the skills under `.claude/skills/`.

## Security notes

- Secrets live in `.env` (git-ignored). Only `.env.example` is committed: every secret in it is blank, and its only filled-in values are public, non-secret defaults (`NEAR_AI_BASE_URL`, `NEAR_NETWORK=testnet`).
- `.gitignore` also excludes key files, NEAR credential folders, Supabase local state and the hackathon submission payload.
- No full-access private key is stored in the repository or sent to an LLM.

## License

MIT — see [LICENSE](LICENSE). This covers EmployAI's own code and documentation only, not third-party tools such as the NEAR agent skills.
