# EmployAI

> Status: **Project foundation only.** No application code exists yet. Every section below marked _(planned)_ is not implemented. This README is updated as each phase lands.

## What it is

EmployAI is a web app where a small-business owner describes their business in plain language. An AI consultant asks follow-up questions, proposes a team of specialised AI agents, generates a constrained workflow for them, and runs it only after the owner approves. A deterministic security gate checks every payment or consequential action before it runs. NEAR testnet provides the agents' accounts, a policy-enforcing treasury contract and an auditable ledger.

The end-to-end demo is a fictional restaurant/café. All demo data is fictional and labelled.

## The problem

Small-business owners know what they want automated but not how to design triggers, workflows and agents. Giving AI agents access to tools and money adds risk: wrong actions, prompt injection, overspending and unsafe recipients.

## NEAR HACKATHON tracks targeted

- `business` — Autonomous Business (primary)
- `swarms` — AI Swarms (only if the 20-buyer / 5-seller market is implemented and reproducible)
- `security` — AI Security & Defense (only if the enforced wrapper, scoped key and attack demo are implemented)

A track is dropped from the submission if its required demonstration is not completed.

## Prerequisites

Versions used to build EmployAI on Windows 11, checked 2026-11-04. Newer patch versions should work.

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 26.13.0 | Web app and worker |
| npm | 12.0.1 | Package manager |
| Git | 2.56.0 | Source control |
| Rust (`rustc` / `cargo`) | 1.99.1, target `wasm32-unknown-unknown` | NEAR smart contracts |
| `cargo-near` | 0.22.0 | Building and deploying contracts |
| `near-cli-rs` (`near`) | 0.30.1 | Testnet accounts and keys |

Check them: `node -v`, `npm -v`, `git --version`, `rustc --version`, `cargo near --version`, `near --version`.

## Try it _(planned — steps will be filled in as features ship)_

1. Do: clone the repo and copy `.env.example` to `.env`. See: _(planned)_
2. Do: install and start the app. See: _(planned)_
3. Do: describe a restaurant in the landing-page hero. See: _(planned)_
4. Do: trigger the demo order. See: _(planned — testnet transaction and ledger entry)_
5. Do: run the prompt-injection attack script. See: _(planned — BLOCK decision, no transaction hash)_
6. Do: run one swarm round. See: _(planned — 20 buyers, 5 sellers, clearing price, allocations)_

## What is live, testnet, simulated

| Feature | Mode |
| --- | --- |
| _(none yet)_ | — |

## Libraries and baseline (HACKATHON.md Q-005)

- NEAR agent skills from [near/agent-skills](https://github.com/near/agent-skills): see [NEAR agent skills (development tools)](#near-agent-skills-development-tools) below.
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
