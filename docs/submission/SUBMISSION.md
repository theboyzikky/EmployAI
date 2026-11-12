# EmployAI — hackathon submission

**Tell EmployAI what your business needs. It builds and operates the AI workforce that gets the work done.**

- **Code:** https://github.com/theboyzikky/employai (branch `hosted-demo-redis`)
- **Live app:** https://employ-ai-eight.vercel.app/
- **Film (≈98 s, 1890×1058, WebM/VP9 + Opus, cinematic score):** `docs/submission/employai-film.webm` (not in git, because it is large; upload it with the submission). The source is `public/video/film.html`.

## The problem
Small businesses lose hours to repetitive work: answering the same customer questions, taking orders, posting, chasing payments. Today's options are a stack of single-purpose tools or chatbots that need setup and never really *do* the work, and handing AI real power (accounts, money) feels unsafe.

## What EmployAI does
1. **Describe the business** in plain words (natural conversation, NEAR AI).
2. **EmployAI proposes AI employees** composed from a library of real skills (e.g. *Customer Support*, *Orders & Sales*), each with responsibilities, restrictions, escalation rules and autonomy. You approve the team.
3. **Connect accounts by external authorization:** click Connect, sign in on the platform (OAuth, Telegram Business, or Meta's WhatsApp sign-up window), and return connected. EmployAI never sees passwords or API keys.
4. **Grant each employee explicit permissions** (read / send messages, publish…). Connecting an account grants nothing by itself.
5. **The automation runs in the background:** incoming customer messages are classified, answered from the owner's approved knowledge and product catalogue, and recorded in the Inbox. Orders are captured for the owner to confirm. Complaints, refunds, unknown products and anything uncertain are escalated to the owner.
6. **The owner monitors** everything in the Inbox and Activity: conversations, drafts, sent replies, orders, leads and escalations, plus approvals, permissions and a kill switch.

## Demo scenario (dress shop)
Owner: *"I sell women's dresses. I want EmployAI to reply to basic customer orders and enquiries automatically."*
- **Price question:** answered with the owner's own catalogue price.
- **"2 of the Emerald wrap dress in size 10":** the order is captured (product, quantity, size); the reply says the owner will confirm and asks for the delivery address.
- **"My dress arrived damaged, I want a refund":** escalated to the owner, with no automatic reply.
- **Safety checks before any automatic send:** no prices outside the catalogue, no refund, discount or guarantee promises, no claim that an order is confirmed, no links. Replies that fail a check wait for the owner.

## Technology
Next.js 16 · TypeScript · Upstash Redis (shared store, compare-and-set commits) · durable task worker (QStash wake-ups, recovery sweep, daily cron, with or without a browser open) · AES-256-GCM per-business credential encryption · NEAR AI (Qwen3.8-27B) for discovery, workforce planning, captions and customer replies.

**NEAR:** NEAR AI powers the reasoning. Payments go through our own NEAR **testnet** treasury contract: the Finance Agent holds a restricted function-call key, and the contract enforces an allowlist plus 0.1 NEAR per payment and 0.25 NEAR per day. A deterministic security gate and owner approval apply to every payment, and there is a kill switch. Two 0.031 NEAR testnet payouts were verified on-chain (`AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP`, `6BV9JEX2bHkEyyYCbFjyuDJtTca8jLekrRP9TA5JRUC4`). **Testnet only.**

## Implemented vs planned (honest status)
| Capability | Status |
|---|---|
| Discovery, workforce planning, approval (live NEAR AI) | Implemented; tested live locally |
| Integrations hub, explicit employee permissions, truthful statuses | Implemented; tested |
| Customer messaging: classify, reply from catalogue, safety checks, approve/auto modes, order capture, escalation, Inbox | Implemented; **tested with simulated providers** (664 automated tests) |
| Telegram Business, WhatsApp, Instagram DMs, Messenger, Gmail, Outlook: connect, receive, reply | Implemented; **not yet tested with a real account.** Each needs the operator's developer app (and Telegram Premium, Meta App Review/business verification, or Google verification) |
| Instagram & Facebook Page publishing with approval and scheduling | Implemented; simulated tests only (no real post yet) |
| NEAR testnet payouts with the 5 safety layers | Implemented; **2 payouts verified on testnet** |
| WhatsApp templates (beyond 24 h), proactive follow-ups, website chat, LinkedIn/X/TikTok/YouTube posting | Planned |

## Deployment status (checked 2026-11-12)
- Deployed on Vercel from `hosted-demo-redis`: https://employ-ai-eight.vercel.app/ (homepage 200).
- Upstash Redis works in production: a session created through the API, plus a message, persisted and reloaded on a later request; another browser gets 404 (owner-only); unsigned webhooks get 401.
- **NEAR AI is not yet active in production:** `AI_PROVIDER=nearai` is set, but the server reports "NEAR AI calls are not approved", so discovery returns `AI_UNAVAILABLE` (it fails closed and never falls back to mock AI). The operator must set `NEAR_AI_CALLS_APPROVED=true` (plus `NEAR_AI_API_KEY`, `NEAR_AI_MAX_CALLS`, `NEAR_AI_MAX_USD_PER_DAY` if missing) in Vercel and redeploy.

Setup steps: `docs/deployment/vercel-upstash.md`.
