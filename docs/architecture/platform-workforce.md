# Platform: dynamic AI workforce and the fashion vertical

EmployAI's promise: **tell EmployAI what your business needs, and it builds and operates the AI workforce that gets the work done.**
This layer sits on the P0 engine ([platform-p0.md](platform-p0.md)). It isn't tied to one platform, one business type or a fixed set of agents.

## Layers

| Layer | Where | What it does |
|---|---|---|
| Skills, roles, capabilities | `src/lib/workforce/registry.ts` | A library of skills, each `operational`, `preview` (demo data) or `planned`. Capabilities such as `social.publish` list their providers, each `available` or `planned`. |
| Workforce planning | `src/lib/workforce/plan.ts`, `service.ts` | NEAR AI composes employees **only from known skills**. Deterministic code drops unknown skills, derives integrations from capabilities, adds universal restrictions, sets autonomy (publishing and payments always need the owner) and adds an orchestrator for teams of three or more. |
| Integrations | `src/lib/integrations/*` | Provider-independent connectors. A new connection grants each action to the employees whose skills need its capability. Credentials are encrypted per business (AES-256-GCM) and never returned. |
| Content pipeline | `src/lib/content/*` | Products (owner's photo, exact price and offer) → AI calendar → AI captions with eight checks → owner approval → a durable `instagram.publish_image` action scheduled for the chosen time. |
| Execution | P0 engine | Durable tasks and write-ahead action attempts; the worker runs from QStash wake-ups, the recovery sweep and the daily cron, never from the browser. A guard re-checks the post at delivery; an observer maps the outcome back to the post. |
| Screens | `/w/[id]/workforce`, `/content`, `/activity` | Plan and approve the workforce; connect Instagram; products, calendar, captions and scheduling; a timeline of everything that happened. |

## Instagram connector

`src/lib/integrations/providers/instagram.ts` (Instagram API with Instagram Login, `graph.instagram.com/v27.0`):

- setup checks the token with `GET /me` and stores it encrypted; the token travels only in an `Authorization` header.
- publish: create a container → wait until `FINISHED` → `media_publish` → read back the permalink. The image must be a public JPEG URL.
- Instagram has no idempotency key. A timeout or 5xx at `media_publish` is recorded as **unknown**, never retried blindly. Reconciliation looks for the exact caption among the 15 most recent posts: found means done, with the real media ID; otherwise the post is escalated to the owner.

## Status (11 Nov 2026)

| Item | Status |
|---|---|
| Workforce planning from free text (live NEAR AI, Qwen3.8-27B) | Tested in the app |
| Approve the workforce, pause and resume employees | Tested in the app |
| Products, AI calendar, AI captions with checks | Tested in the app with live NEAR AI |
| Approve and schedule, publish at the set time, cancel, pause, kill switch, reconcile an unknown outcome | Tested in the automated suite against a simulated Instagram API (`tests/platform-content.test.ts`) |
| A real Instagram publication | **Not yet done.** Needs the owner's Instagram access token. |
| Publicly visible in a logged-out browser | **Not yet done.** Depends on the publication above. |
| A scheduled post published by the deployed worker with the browser closed | **Not yet done.** Needs deployment approval and the environment below. |

## Owner steps for the three acceptance criteria

1. **Get a token.** In the Meta App Dashboard, go to Instagram → API setup with Instagram login. Add your professional Instagram account and generate an access token. Never paste it into a chat.
2. **(Optional) Check it outside the app.** In your own terminal, set `IG_ACCESS_TOKEN`, then run `node scripts/meta-publish-check.mjs check` (this posts nothing).
3. **Deploy** (needs your approval). Set `APP_ENCRYPTION_KEY` (32+ random characters), `EMPLOYAI_PUBLIC_URL` (the deployment's https URL), `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `EMPLOYAI_WORKER_SECRET` and `CRON_SECRET`, plus the existing Upstash and NEAR AI variables ([vercel-upstash.md](../deployment/vercel-upstash.md)).
4. In the deployed app, follow these steps:
   1. Open **Workforce**. Describe the business, plan the workforce and approve it.
   2. Paste the token into **Connect Instagram**.
   3. Open **Content**. Add a real product with its real JPEG photo (uploading it works once deployed) and its exact price.
   4. Plan the calendar and write a caption.
   5. Choose a time about 10 minutes ahead, select **Approve & schedule**, then **close the browser**.
5. After the scheduled time, open **Activity**. You should see "Post published" with the media ID and a "View post" link.
6. Open that link in a private window (logged out) to confirm the post is public.

If Instagram refuses (for example the account isn't a professional account, or the app is in development mode and posts aren't public), the post goes to `failed` or `needs_attention` with Instagram's own error message. Record that message as the blocker.

## Connections hub (Integrations tab)

The owner connects each account once in **Integrations** (`/w/[id]/integrations`): for social networks, **Connect** redirects straight to the platform's own consent page and back. That needs no developer knowledge from the owner; it needs the operator (whoever runs EmployAI) to register one developer app per platform, once, and set its client id and secret. Employees never hold an account: they ask for **capabilities** (`publish_social_post`, `reply_to_customer`, `send_email`, `send_message`, `retrieve_analytics`, …), and `src/lib/integrations/resolve.ts` resolves each one to a connection the owner has authorised for that employee.

| Piece | Where |
|---|---|
| Provider catalogue: every provider, its category, capabilities and honest support level | `src/lib/integrations/catalogue.ts` |
| Official OAuth flows (state hashed in KV for 10 min, single use, owner cookie required at the callback; PKCE for Google and Microsoft; minimum scopes; granted scopes checked; tokens encrypted; refresh before use; a revoked token puts the connection in "Reconnection required") | `src/lib/integrations/oauth.ts`, `src/app/api/oauth/[provider]/callback/route.ts` |
| Connection lifecycle: least-privilege default grants, per-employee permissions, disconnect (deletes credentials and grants), reconnect (same connection, history kept), check | `src/lib/integrations/connections.ts` |
| Hub view and readiness ("ready now / needs a connection / needs your attention / not possible yet") | `src/lib/integrations/hub.ts`, `src/lib/workforce/readiness.ts` |
| Connectors | `providers/instagram.ts`, `providers/email.ts` (Gmail, Outlook), `providers/telegram.ts`, `providers/webhook.ts` |

**Connecting:** the owner clicks **Connect**, EmployAI redirects the browser to the platform's own sign-in and consent page (official OAuth endpoint, minimum scopes, single-use state bound to the business and the owner's browser, PKCE for Google, Microsoft and X), the platform sends the owner back to `/api/oauth/<platform>/callback`, the server exchanges the code, verifies the account, checks the granted scopes and stores the tokens encrypted. The owner lands back where they started and sees the account's real identity. Declined or failed attempts store nothing and the reason is shown on the provider's row. Callback URLs must be https outside local development. Passwords are never entered into EmployAI. (Telegram bots have no OAuth: the bot token from @BotFather is Telegram's own method. Instagram keeps a "developer testing only" token option, shown only while its OAuth app isn't configured.)

**Statuses shown:** Connected · Ready to connect (Connect redirects now) · Developer setup required (the OAuth flow is built but this server has no developer app credentials; the row names the variables and the callback URL to register) · Not connected (token or webhook providers) · Reconnection required (revoked, expired or missing scopes) · Paused · Available but not implemented · Unsupported. Each provider's row also shows a checklist: OAuth built, credentials configured, account connected, what data is read, which actions exist, and whether they run in the background. Each capability on a card says "(not yet)" unless the connector really implements it.

**Permissions** are separate from connections. Connecting an account grants **nothing** to any employee; the owner explicitly grants each employee, per connection, the categories it needs (read messages, draft messages, send messages, create content, publish content, read analytics, other actions), either in the table on the provider's row or with one **Allow** click where the Workforce tab lists what an employee is missing. Disconnecting clears every grant; reconnecting doesn't restore them. Approvals for posts and payments, spend limits and the kill switch still apply on top of these grants.

**AI awareness:** the workforce planner receives the business's real connection registry. The Workforce tab shows what is ready now, which connections are missing and why (offering only providers that really perform the capability), and which employee still needs the owner's permission. Its **Connect** button starts the platform's OAuth flow directly and returns to the Workforce tab, which says what happened and continues from where the owner was; nothing has to be re-entered.

### Provider status (11 Nov 2026)

| Provider | Status in this build | What the owner needs |
|---|---|---|
| Instagram | Implemented: publish image posts. OAuth flow plus a pasted-token option. Not yet verified with a real account. | A professional account. OAuth needs `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`, and Meta App Review for accounts other than the app's testers. |
| Gmail | Implemented: send email (OAuth, `gmail.send` only). Not externally verified. | A Google Cloud OAuth client: `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, Gmail API enabled, callback URL registered, test users until Google verifies the app. |
| Outlook / Microsoft 365 | Implemented: send email (OAuth, `Mail.Send`). Not externally verified. | An Entra app registration: `MICROSOFT_OAUTH_CLIENT_ID`/`SECRET`, callback URL registered. Some organisations need admin consent. |
| Telegram | Implemented: receive messages (signed webhook) and send messages (bot token). Not externally verified. | A bot from @BotFather. Receiving needs a public https address (`EMPLOYAI_PUBLIC_URL`). |
| Signed webhook | Implemented and tested. | None. |
| Facebook Pages | Implemented: one-click connect (Facebook Login → long-lived token → Page token) and publishing image posts through the same approval and scheduling as Instagram. Not externally verified. | A Meta app with Facebook Login: `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`. Pages of people other than the app's testers need Meta App Review. |
| LinkedIn, X, TikTok, YouTube | One-click connect implemented: the account is verified and its tokens are stored encrypted and renewed (LinkedIn has no programmatic refresh, so the owner reconnects every 60 days). **Posting to them isn't built yet**; every screen says "(not yet)" and they're never offered for publishing. | A developer app on each: `LINKEDIN_CLIENT_ID`/`SECRET`, `X_CLIENT_ID`/`SECRET`, `TIKTOK_CLIENT_KEY`/`SECRET`; YouTube uses the Google client with the YouTube Data API. |
| WhatsApp Business, website chat, IMAP/SMTP, Google Calendar, Google Drive | Available but not yet implemented. Shown with their setup requirements and never as connectable. | Developer apps or reviews, listed on each card. |
| WhatsApp (personal app) | Unsupported: no official API. | Use WhatsApp Business. |

Reading email and replying to customer enquiries automatically are **not built**. The Gmail and Outlook scopes are send-only, and the "answer enquiries" skill is planned. The Workforce tab says so instead of showing them as ready.

## Customer messaging (Inbox)

One support employee answers customers on every connected channel; the owner sees everything in **Inbox** (`/w/[id]/inbox`).

| Piece | Where |
|---|---|
| Conversations, reply proposal schema, deterministic reply checks, offline (labelled) fallback | `src/lib/messaging/model.ts` |
| Filing inbound messages, the employee's decision, approvals, owner replies, settings | `src/lib/messaging/service.ts` |
| Send-time guard and delivery observer for every `<connector>.reply` action | `src/lib/messaging/hooks.ts` |
| Channel contract (inbound payload, `ReplyInput`) | `src/lib/integrations/messaging-contract.ts` |
| Platform webhooks | `/api/hooks/telegram` (secret-token header), `/api/hooks/meta` (verify token + X-Hub-Signature-256) |
| Mailbox polling (Gmail, Outlook) | `poll_mailbox` task, `src/lib/automation/handlers.ts` |

**How a message is handled.** A verified webhook (or a mailbox check) stores the message once per provider message id and queues a durable task. The worker files it in its conversation; if the owner has allowed an active employee with the *Answer customer enquiries* skill to read **and** send on that account, the employee classifies it and drafts a reply from the owner's approved knowledge and products only. Code then decides:
- complaints, refunds, sensitive topics, missing facts, spam, or a closed 24-hour window (Instagram, Messenger, WhatsApp) → **escalated** to the owner (a suggested reply may wait as a draft);
- default mode → **draft** waiting for the owner's approval;
- "routine replies go automatically" → sent **only** if every check passes (no unapproved prices, no refund/discount/guarantee promises, no links, length).
Leads are flagged (and handed to a sales employee when the workforce has one). Replies are durable actions on the same connection, re-checked at send time; an unconfirmed delivery waits for the owner and is never re-sent. An hourly cap per business limits AI replies.

**Connecting each channel** (Connect → the provider's own authorization → back to EmployAI):

| Channel | Authorization | Inbound | Outbound | Status (11 Nov 2026) |
|---|---|---|---|---|
| Telegram | Telegram deep link to EmployAI's bot → owner adds it under Telegram Business → Chatbots (Telegram shows the rights). Needs Telegram Premium. | `business_message` on the bot webhook | `sendMessage` with `business_connection_id` | Built; simulated tests only |
| WhatsApp Business | Meta Embedded Signup window (Facebook Login for Business) | Meta webhook (`messages`) | Cloud API `/<PHONE_NUMBER_ID>/messages` | Built; simulated tests only |
| Instagram Direct Messages | OAuth (Instagram Login, `instagram_business_manage_messages`) | Meta webhook (`messages`) | `graph.instagram.com/<IG_ID>/messages` | Built; simulated tests only |
| Facebook Messenger | OAuth (Facebook Login, `pages_messaging`, `pages_manage_metadata`) | Meta webhook (`messages` on Page) | `/<PAGE_ID>/messages` (RESPONSE) | Built; simulated tests only |
| Gmail | OAuth (`gmail.readonly` + `gmail.send`) | Polled (history.list) | `messages.send` in thread | Built; simulated tests only |
| Outlook / Microsoft 365 | OAuth (`Mail.Read` + `Mail.Send`) | Polled (delta query, Focused) | `/messages/{id}/reply` | Built; simulated tests only |
| LinkedIn messaging | — | — | — | Unsupported (partner-only API) |
| Website chat | — | — | — | Not built |

**Not built yet:** WhatsApp message templates (needed to write to a customer more than 24 hours after their last message), proactive follow-up campaigns, WhatsApp phone-number registration from EmployAI (finish it in WhatsApp Manager if a new number shows as pending), media attachments (shown as "[an attachment]").
