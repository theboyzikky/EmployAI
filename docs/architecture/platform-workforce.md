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
