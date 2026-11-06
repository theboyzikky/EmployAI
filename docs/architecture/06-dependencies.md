# 06 · External dependencies (simplified scope)

Status: **Revised 2026-11-05 to match [00-mvp-scope.md](00-mvp-scope.md).** Versions were checked against npm, crates.io and vendor docs on 2026-11-04. Exact pins are set in M1 with a real build.

## Local toolchain (installed and verified)

| Tool | Version | Notes |
|---|---|---|
| Node.js / npm | 26.13.0 / 12.0.1 | Meets every engine floor below |
| Git | 2.56.0 | |
| Rust / Cargo | 1.99.1 + `wasm32-unknown-unknown` | |
| cargo-near | 0.22.0 | ✅ Verified on Windows in M0: `cargo near build non-reproducible-wasm --no-abi` (ABI generation fails to link with MSVC). Unit tests need `AWS_LC_SYS_PREBUILT_NASM=1` (otherwise NASM is required). The official template pins Rust 1.93.0. |
| near-cli-rs | 0.30.1 | Owner setup and owner scripts |
| Supabase CLI | not installed → `npm i -D supabase` (3.0.0) | Used only for `migration new` and `db push` to the hosted project. No Docker needed for that. |
| Docker, WSL2 | not needed | The NEAR sandbox has no Windows build, so the contract is tested with Rust unit tests plus testnet scripts |

## Services and accounts

| Service | Purpose | What the owner provides | Status |
|---|---|---|---|
| **NEAR AI Cloud** `https://cloud-api.near.ai/v1` | **Mandatory product AI and final demo**: Qwen 3.8 27B (discovery JSON), Haiku 5.5 (tool calls) | Key in `.env` (verified, never printed). Every spending batch needs your approval. | ✅ PoC-A done: billed $0.012238 for 36 calls. Adapter validated offline (PoC-A0). |
| **Offline demo AI** (built in) | Default AI provider: rules + fixtures | nothing | Built in M2–M4 |
| **Ollama** (optional, local, free) | Local model as an alternative real-inference provider | Approval to download a small model (~1–3 GB) | v0.40.6 installed, no models; CPU-only laptop, so slow |
| **Supabase** (free tier) | Postgres + Auth (anonymous sessions) | One free project: URL, anon key, service-role key. I'll check the free-tier terms first. | Checked in **PoC-C**. No-sign-up alternative: D-23. |
| **NEAR testnet RPC** | Reads and transaction submission | none (public) | ✅ verified |
| **NearBlocks testnet API** | Account age and activity signals | none (free tier) | ✅ verified |
| **NEAR testnet faucet** | Fund about 9 accounts | none | Amount and limits checked in **PoC-B** |
| **Hosting** | **None by default** (local run + video, Q-012). A free tier only if you approve one that needs no payment. | — | Decided at M7 (D-10) |
| GitHub, X, mainnet NEAR wallet (prize payout) | Submission | Owner | Gate 6 |
| ~~OutLayer, NEAR Intents/1Click, Agent API, PingPay~~ | — | — | **Not used.** Intents and the Intents-based services are mainnet-only. OutLayer isn't needed with a function-call key. |

**Testnet accounts (9), created by the owner-run `scripts/provision-testnet`:** `employai-demo.testnet` (parent, currently free), plus `treasury.`, `finance-agent.`, `contributors.`, `customer-demo.`, `supplier-1.`, `supplier-2.`, `supplier-3.`, `scam-supplier.` (labelled fixture).

## npm packages

| Package | Latest (2026-11-04) | Use |
|---|---|---|
| `next` | 16.4.5 | App (peer `react ^19`, `node ≥20.9`) |
| `react`, `react-dom` | 19.3.1 | UI |
| `typescript` | 7.0.2 (6.0.3 fallback) | ⚠ TS 7 is days old. If the Next build or tooling objects, pin 6.0.x (decided in M1). |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.4 | Styling |
| `@phosphor-icons/react` | 2.1.10 | **Installed (M1).** The only icon family; server-safe per-icon imports (`dist/ssr/*`) |
| `@tailwindcss/turbopack` | 4.3.4 | **Installed (M1).** Tailwind loader used by the official Next 16 template |
| ~~`lucide-react`~~ | — | **Replaced by Phosphor** (owner decision 2026-11-05) |
| `zod` | 4.6.7 | All schemas (profile, agent, workflow, policy, action) |
| `@supabase/supabase-js`, `@supabase/ssr` | 2.118.0, 0.12.7 | DB and auth |
| `openai` | 7.50.0 | **Installed (M2).** NEAR AI Cloud client (OpenAI-compatible), `maxRetries: 0` |
| `near-api-js` | 7.4.0 | RPC, function-call key signing, contract calls (the official SDK, covered by the installed `near-api-js` skill) |
| `yaml` | 2.9.1 | Reads `config.yaml` |
| `vitest` | 5.1.0 | **Installed (M2, dev).** Unit and route tests (`npm test`). Its peer range required `@types/node` ^22 (the template had ^20); dev-only types, Node 26 runtime unchanged. |
| `@playwright/test` | 1.64.1 | One end-to-end happy path plus a mobile check |
| `tsx` (dev) | 4.23.15 | Runs the TypeScript scripts (attack demo, provisioning helpers) |

**Removed from the earlier proposal:** `pg-boss`, `graphile-worker`, `@hot-labs/near-connect`, `near-kit`, `@outlayer/sdk`, `motion`, workflow canvas libraries.

## Rust crates

`near-sdk` 5.30.0 (contract) · `cargo-near` 0.22.0 (build and deploy). `near-workspaces` isn't used (its sandbox has no Windows build); integration is tested on testnet by scripts.

## NEAR AI Cloud models (D-05, used only if real inference is approved)

From the live catalogue, 2026-11-04. These are advertised features; PoC-A verifies them.

| Model | Advertised | Price per 1M tokens (input / output) | Role |
|---|---|---|---|
| `anthropic/claude-haiku-5-5` | tools, structured_outputs | $0.10 / $0.50 | **Tool calls only** (procurement, M4). Not used for discovery: it produced 0/8 valid strict-JSON responses in PoC-A. |
| `anthropic/claude-sonnet-5-5` | tools, structured_outputs | $2 / $10 | Team proposal and workflow generation (few calls) |
| `Qwen/Qwen3.8-27B` | tools, structured_outputs | $0.04 / $1.35 | **Structured discovery** (PoC-A: 5/5 valid). Hosting environment **not verified by us**; no TEE or privacy claim is made. |

## Environment variables

These are proposed changes to `.env.example`. I'll apply them in M1 once you approve.

| Variable | Scope | Change |
|---|---|---|
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | keep |
| `SUPABASE_SERVICE_ROLE_KEY` | server | keep |
| `DATABASE_URL` | — | **remove** (supabase-js is enough; the CLI links the project itself) |
| `NEAR_AI_BASE_URL` (`https://cloud-api.near.ai/v1`), `NEAR_AI_API_KEY` | server | keep |
| `NEAR_AI_STRUCTURED_MODEL` (default `Qwen/Qwen3.8-27B`), `NEAR_AI_TOOL_MODEL` (default `anthropic/claude-haiku-5-5`) | server | **add** (task routing from PoC-A) |
| `AI_PROVIDER` (`mock` \| `nearai` \| `ollama`, **no default**: must be set) | server | **add**: switches providers without code changes; unset means the app refuses to start AI features |
| `NEAR_AI_CALLS_APPROVED` (`false` unless approved), `NEAR_AI_MAX_CALLS`, `NEAR_AI_MAX_USD_PER_DAY`, `NEAR_AI_TIMEOUT_MS` | server | **add**: spending safeguards; `nearai` refuses to run without all of them (validated in PoC-A0) |
| `OLLAMA_BASE_URL` (`http://localhost:11434/v1`), `OLLAMA_MODEL` | server | **add** (optional) |
| `NEAR_NETWORK=testnet`, `NEAR_RPC_URL` | server | keep; default `https://test.rpc.fastnear.com` |
| `NEAR_PARENT_ACCOUNT_ID`, `NEAR_TREASURY_CONTRACT_ID` | server | keep |
| `NEAR_FINANCE_AGENT_ACCOUNT_ID` | server | **add** |
| `NEAR_FINANCE_AGENT_PRIVATE_KEY` | server (secret) | **add**, replacing `NEAR_SIGNER_SECRET`. A function-call key only. |
| `NEAR_DEMO_CUSTOMER_ACCOUNT_ID`, `NEAR_DEMO_CUSTOMER_PRIVATE_KEY` | server (secret) | **add** (D-20) |
| `NEAR_SIGNER_SECRET` | — | **remove** |
| `NEARBLOCKS_API_BASE` (`https://api-testnet.nearblocks.io`) | server | **add** |
| `OUTLAYER_API_KEY`, `OUTLAYER_BASE_URL`, `APP_ENCRYPTION_KEY` | — | **remove** (not used) |
| `DEMO_MODE` | server | **add** (shows demo controls and labels) |
