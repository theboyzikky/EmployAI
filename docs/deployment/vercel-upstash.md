# Hosted demo: Vercel + Upstash Redis

This guide covers the public demo that judges can use, with real NEAR AI and real NEAR testnet payments. Locally, nothing changes: `npm run dev` uses the file store and an in-process lock store.

## How the hosted demo stays safe with many visitors

| Concern | How it's handled |
| --- | --- |
| Data shared by every server instance and kept across restarts | Upstash Redis. Each workspace is one versioned document. Every write is one atomic compare-and-set commit (Lua): if another instance changed the workspace in the meantime, the change is re-applied to the fresh copy. No update is ever lost. |
| Isolation between judges | Each browser gets a random 256-bit owner cookie (HTTP-only, SameSite=Lax, Secure); only its SHA-256 is stored. Every `/api/w/<id>` route returns 404 to anyone else. A transaction is scoped to one workspace (plus the shared blocklist); touching another workspace is refused (ScopeViolation). |
| Workspace expiry | A workspace, with its owner-index entry and public-ledger link, expires **60 days after its last change** (`EMPLOYAI_WORKSPACE_TTL_DAYS`). The shared blocklist never expires. |
| Business lock across instances | In-process FIFO queue, plus a shared lease (unique token, 30 s, renewed every 10 s). The work runs inside the lease's fence: if the lease is lost, every later write by that holder fails. |
| Concurrent payments, duplicate payouts | One **signer lease** per Finance Agent key across all instances, held from the nonce read to the broadcast. The write-ahead commit and the switch to "submitting" are fenced, needing at least 10 s of lease left. The write-ahead raises a shared nonce floor in the same atomic step. Unchanged underneath: one active attempt per request id, compare-and-set on every attempt transition, write-ahead before broadcast, unknown outcomes reconciled (never blindly retried), every owner approval bound to the exact payment, and the contract paying each request id at most once. |
| AI cost | The spending guard's check-and-reserve is one atomic step in Redis. Concurrent calls on any instances can't pass `NEAR_AI_MAX_USD_PER_DAY` or `NEAR_AI_MAX_CALLS`. An unsettled reservation stays counted at worst case. |
| Abuse | Shared fixed-window limits, mostly per workspace and more loosely per IP (IPs are stored only as salted hashes): new conversations, AI calls, and real testnet runs per day. You get 429 with Retry-After. |
| Redis unreachable | Everything fails closed: no AI call, no signature, no broadcast, no write. You get 503 or an error, never an unprotected path. |
| Operator pause | In the Upstash console: `SET eai:ops:testnet_paused 1` stops new signatures and broadcasts (unsent payments are aborted; unknown outcomes are only reconciled). `SET eai:ops:ai_paused 1` stops live AI. `DEL` to resume. No redeploy is needed. |

On-chain limits are unchanged and enforced by the contract: 0.1 NEAR per payment, 0.25 NEAR per day, payouts only to `supplier-1` and `supplier-2.employai-demo.testnet`, and one payout per request id. The demo order is 0.031 NEAR, so about 8 real payouts fit in a day, **shared by every visitor**. After that the gate blocks before signing; simulated runs keep working.

## Free-tier facts (checked 2026-11-10 on the providers' own pages)

**Upstash Redis Free** ([pricing](https://upstash.com/pricing/redis)):
- 500K commands per month;
- 256 MB data (the page also says 250 MB);
- 10 MB max request;
- 100 MB max record;
- 10 GB bandwidth per month;
- 1 database;
- 10,000 commands per second;
- **no uptime SLA** (that's a paid add-on).

Lua `EVAL` works over the REST API ([docs](https://upstash.com/docs/redis/commands/scripting/eval)). Inactive free databases may be **archived** (a backup is kept and can be restored; [FAQ](https://upstash.com/docs/redis/help/faq)). Keep the database in use during judging.

**Vercel Hobby** ([plan](https://vercel.com/docs/plans/hobby), [fair use](https://vercel.com/docs/limits/fair-use-guidelines)):
- free;
- functions up to 300 s;
- 1M function invocations, 100 GB fast data transfer and 4 active-CPU hours per month;
- runtime logs kept 1 hour;
- **non-commercial personal use only**. Commercial means a deployment used for anyone's financial gain, for example processing payments from visitors or ads.

A non-commercial hackathon demo that takes no payments, where the testnet tokens have no value, appears to fit. If hackathon prize money worries you, ask Vercel support.

Free tiers aren't production reliability: there's no SLA and no paid support, and limits pause service until the month resets. The demo fails closed when a limit or an outage hits.

**Rough usage:**
- An API request costs about 5–25 Redis commands: reads, a commit, a lock, a rate limit.
- A full judge walkthrough (discovery → team → workflow → runs → one real payment) is about 1–3K commands.
- So 500K a month covers a few hundred walkthroughs. Check Upstash's usage page during judging.

The largest workspace in the local store today is 280 KB, well under the 10 MB request limit.

## Deploy (step by step)

1. **Upstash.** In Vercel, open the project, then **Storage → Marketplace → Upstash (Redis) → Free**. Connect the database to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`); the app accepts either pair. Pick a region close to your Vercel functions.
2. **Environment variables** (Vercel → Settings → Environment Variables; mark keys **Sensitive**; never use a `NEXT_PUBLIC_` name for a secret):
   - **AI:**
     - `AI_PROVIDER=nearai`
     - `NEAR_AI_API_KEY`
     - `NEAR_AI_BASE_URL`
     - `NEAR_AI_CALLS_APPROVED=true`
     - `NEAR_AI_MAX_USD_PER_DAY` (suggested `2`)
     - `NEAR_AI_MAX_CALLS`, a lifetime ceiling (suggested `5000`). The real backstop is the credit left on the NEAR AI key: keep it small.
   - **NEAR testnet:**
     - `NEAR_NETWORK=testnet`
     - `NEAR_PARENT_ACCOUNT_ID`
     - `NEAR_TREASURY_CONTRACT_ID`
     - `NEAR_FINANCE_AGENT_ACCOUNT_ID`
     - `NEAR_FINANCE_AGENT_PRIVATE_KEY`: the **restricted function-call key** only. The app refuses any other key.
   - **Optional:**
     - `EMPLOYAI_WORKSPACE_TTL_DAYS` (60)
     - `EMPLOYAI_RATE_LIMIT_SALT`, any random string
     - limits: `EMPLOYAI_LIMIT_START_PER_IP_10MIN` (20), `EMPLOYAI_LIMIT_AI_PER_WORKSPACE_DAY` (80), `EMPLOYAI_LIMIT_AI_PER_IP_DAY` (300), `EMPLOYAI_LIMIT_TESTNET_RUNS_PER_WORKSPACE_DAY` (4), `EMPLOYAI_LIMIT_TESTNET_RUNS_PER_IP_DAY` (8)
3. **Deploy** (push to the connected branch, or **Redeploy**). Open the site. The hero shows the "Public demo" privacy notice, and the testnet panel shows the shared-cap notice. If they're missing, the app isn't seeing the Upstash variables.
4. **Check before announcing it:**
   - start a conversation;
   - finish discovery;
   - approve the team and the workflow;
   - do a simulated run;
   - do one real testnet run (arm a batch, approve), then open the explorer link;
   - publish the ledger and open the public link in a private window;
   - set and clear `eai:ops:testnet_paused`.
5. **Treasury balance.** About 1.75 NEAR of the treasury is locked for contract storage. Check that the spendable balance covers the expected payouts, and top up from the testnet faucet if needed.

On Vercel without Upstash configured, every operation fails closed with "shared store isn't configured". The app never silently falls back to `/tmp` or memory.

## Optional: copy local workspaces to the hosted store

This copies your local workspaces, for example the published ledger with the verified payouts, into the hosted store. It uploads their content to Upstash, so only do it for data you're happy to host.

```bash
node scripts/shared-store-migrate.mjs plan
```

The dry run makes no network calls and never writes the local file. It prints counts, bytes and a checksum.

```bash
node --env-file=.env.hosted scripts/shared-store-migrate.mjs apply
```

Here `.env.hosted` holds only the Upstash URL and token. Each workspace is written with `MSETNX`, all or nothing and only if absent, so nothing already in Upstash is overwritten. Every written document is read back and compared byte for byte, and the local file's checksum is verified unchanged. Use `--only <id,…>` to copy selected workspaces.

Owner cookies are per domain, so migrated workspaces are reachable only through their public ledger links, not through your browser on the new domain.

## Rollback

- **Code:** this work is on branch `hosted-demo-redis`. `main` still has the single-process version, and redeploying it from Vercel's deployment list is instant.
- **Hosted data:**

```bash
node --env-file=.env.hosted scripts/shared-store-migrate.mjs export --out .data/backups/hosted-export-<date>.json
```

  This writes a **new** dev-store file (it refuses to overwrite one) that the local app can open.
- **Local data:** never written by any of this. A checksummed backup from before the migration work is at `.data/backups/dev-store.pre-redis-20261110-195523.json`.

## Testing against a real Upstash database

`npm test` runs everything against the file store, and `npm run test:shared` runs everything against the shared store (in-process). Neither touches the network.

To check the Lua scripts against a real Redis, use a **separate, disposable** free database (not the demo's):

```bash
KV_CONTRACT_UPSTASH_URL=… KV_CONTRACT_UPSTASH_TOKEN=… npx vitest run tests/kv-contract.test.ts
```

## Limitations that remain

- The 0.25 NEAR per day on-chain cap is shared by all visitors (about 8 payouts at 0.031 NEAR). It can't be raised without a contract change.
- Without sign-in, a determined abuser with many IPs can use up the day's shared AI or testnet allowance for everyone. Cost stays capped and no funds beyond the caps can move, but other judges would wait until the next day (UTC). The operator pauses help here; a CAPTCHA (for example Cloudflare Turnstile) would be the next step.
- Sessions are bearer cookies: anyone with the same browser profile shares the workspace, and clearing cookies loses access. There are no accounts or recovery.
- What judges type is stored in Upstash (60 days) and sent to NEAR AI. The UI says so.
- If the restricted Finance Agent key leaked from Vercel, it could call the contract directly and bypass the app's gate and approvals. The contract would still allow only `request_payment`, to the two allowlisted supplier accounts (yours), within the caps, and once per request id. Revoke it with the owner account.
- Across instances the business lock polls instead of queueing in FIFO order. Within one instance FIFO order is kept.
