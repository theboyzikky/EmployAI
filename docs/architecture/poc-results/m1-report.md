# M1 report · application foundation and landing page

Date: **2026-11-05**. Scope approved by the owner: Next.js + TypeScript setup, design system, responsive navigation, the complete landing page, the hero conversational input, a working message handoff into onboarding, motion, basic accessibility and error handling.

Constraints honoured:
- no paid services
- no NEAR AI calls
- no NEAR accounts or deployments
- no Supabase project created
- no commit or push

## What was built

| Area | Result |
|---|---|
| Project | Next.js **16.4.5** (App Router, Turbopack, Cache Components + Partial Prefetching as in the official template), React 19.3.0, TypeScript **5.9.3** (from the official template; D-18 resolved), Tailwind CSS 4.3.4 via `@tailwindcss/turbopack`, `@phosphor-icons/react` 2.1.10, zod 4.6.7. **5 runtime dependencies, 6 dev dependencies.** No component library and no animation library. |
| Design system | `src/app/globals.css`: colour tokens (Black `#111111`, Deep Purple `#482477`, Pale Lavender `#F3EFF9`, Soft White `#F8F8FA`, border `#E4E0EA`, muted text), **Manrope 300–700 only** (Tailwind's extrabold, black, thin and extralight utilities are removed from the theme), one button system (`btn-primary` black / `btn-secondary` black outline / purple hover; consistent 46/52/40 px heights, pill radius, padding), chips, cards, eyebrow pill, gradient text |
| Icons | `src/components/icons`: a **central Phosphor registry** (the only import source) plus one `Icon` component that stacks the Regular and Fill weights of the **same glyph** and cross-fades them in CSS. Hover, focus, `aria-current`, `aria-selected`, `aria-pressed` and `data-active` show Fill; `state="active"` gives Fill + deep purple; `state="disabled"` gives muted Regular with no swap. It works in Server Components with no client JavaScript. Icons are imported per file from `dist/ssr/*` and use the new `…Icon` names (the plain names are deprecated in 2.1.10). |
| Motion | CSS only. The hero enters on load (fade + upward move, staggered 80 ms). Sections reveal once on scroll through `IntersectionObserver` (520 ms, 50–100 ms staggers). Decorative hero icons float slowly (7–10 s). Hovers take 180–220 ms, with a subtle lift and scale on cards and buttons. The workflow demo lights up step by step, with a connecting line that fills. **`prefers-reduced-motion`:** no floating, no movement, opacity-only reveals (150 ms), no hover lift, no smooth scroll. A `<noscript>` rule keeps content visible without JavaScript. |
| Landing page (11 parts) | Navbar (sticky, blurs on scroll, mobile drawer) · Hero (headline, supporting text, 2 CTAs, floating icons from 1280 px) · **hero chat** (example chips, Enter to send, validation, error state) · How EmployAI works · Meet your AI workforce (Orchestrator + 4 specialists, each with a boundary) · Business workflow (6-step animated illustration, **labelled "Illustration"**) · Security & business control · Supported integrations · FAQs (7, native `<details>`) · Final CTA · Footer |
| Honest content | No testimonials, metrics or client logos. The reference image's third-party logo strip (Airwallex, Airbnb, GitHub, Notion…) was **not reproduced**. Integrations show only **NEAR AI Cloud** and **NEAR Protocol (testnet)**, and the rest are generic categories marked "Planned". Footer pages not yet written are shown as "Coming soon" text, not dead links. The hero status pill says "Ready", not "Online", because no AI is connected yet. |
| Handoff | `POST /api/start` checks content type, same origin and a per-IP rate limit (20 per 10 min), validates and normalises the text with zod (1–4 000 characters, control characters stripped, unknown fields rejected), creates a session and sets an httpOnly, SameSite=Lax owner cookie (only its SHA-256 is stored), then returns the redirect. `/start/[sessionId]` shows the **exact original message**, and only to the browser that created it. `/start` is a fresh conversation for CTAs without a message. |
| Onboarding UI | Consultant layout: a top bar with **stage progress** (Understand business → Map operations → Recommend agents → Review plan) and a save status; the conversation column; a **"What I understand"** panel (sticky on desktop, collapsible on mobile, honestly "Not yet known"); a composer. A clearly labelled system note says the NEAR AI consultant is connected in the next stage and that **no AI has analysed the message**. |
| Session storage (temporary) | `src/lib/discovery/store.ts`: an interface plus a **local development JSON store** in `.data/` (git-ignored, atomic writes). It is replaced by Supabase (anonymous Auth + RLS) in M2. Nothing else depends on the file store. |

## Verification

| Check | How | Result |
|---|---|---|
| Type check | `tsc --noEmit` | ✅ 0 errors |
| Production build | `npm run build` | ✅ Compiled; `/` and `/start` static, `/start/[sessionId]` partial prerender, `/api/start` dynamic |
| Typography | Computed font weight of every element on the production page | ✅ Only **300, 400, 500, 600, 700**, in **Manrope** |
| Icon swap | Hover a chip, then read the computed opacity of both SVGs | ✅ Regular 0, Fill 1, same glyph; the mobile menu toggle shows Fill when pressed |
| Hero → onboarding (dev and production) | Typed or example text, Enter | ✅ Navigates to `/start/<uuid>` and shows the **exact** text (including "café & bar"), "Saved" |
| Example chips | Click | ✅ Fill the input, move focus there with the caret at the end, **never submit** |
| Empty input | — | ✅ Send disabled; Enter does nothing |
| API validation | Blank, 4 001 characters, malformed JSON, form-encoded, extra field | ✅ 400, 400, 400, 415, 400, with an error envelope and correlation ID |
| Cross-site POST / rate limit / GET | curl with a foreign `Origin`, 21 rapid posts, GET | ✅ 403 / 21st → 429 / 405 |
| Session privacy | The session URL fetched without the owner cookie, an unknown UUID, a malformed ID | ✅ The message is **never** in the response; a not-found page is shown; the page is `noindex` |
| Links and CTAs | All 23 links on `/` | ✅ Every anchor has a target; `/` and `/start` → 200; no external links |
| Responsive | 1440×900, 1024, **768 (tablet)**, **375 (mobile)** | ✅ **No horizontal overflow** at any size; desktop navigation from 768 px, drawer below that |
| Mobile menu | Open, Escape, link | ✅ `aria-expanded`, focus moves into the menu, scroll locked, Escape closes and returns focus to the toggle |
| Accessibility scan (scripted) | Names, labels, IDs, landmarks, contrast | ✅ No unnamed controls, every input labelled, no SVG exposed to assistive tech, one H1 with ordered headings, landmarks present, `lang="en"`, skip link. Fixed during M1: small "Planned" / "Coming soon" / "Not yet known" text was 3.3:1, now uses the muted colour (≈ 7:1); a duplicate SVG gradient ID was removed from the logo. |
| Reduced motion | The browser pane can't emulate the setting, so the shipped CSS was inspected | ✅ The reduced-motion block covers entrances, reveals, workflow steps, floating icons, status dot, lines, hover lifts and the icon cross-fade. **Not observed visually.** |
| Console | Production pages | ✅ **No console output at all** (errors seen in dev were only my deliberate invalid API requests). A Next.js smooth-scroll warning was fixed with `data-scroll-behavior="smooth"`. |

## Known limitations and notes

1. **No real AI yet:** this was by design for M1. The consultant arrives in M2 through NEAR AI Cloud, under an approved budget.
2. **Sessions live in a local file** until Supabase is created (M2). That's fine for a single local server, but not for multi-instance hosting.
3. **The not-found case returns HTTP 200:** with Cache Components, the session check runs inside a streamed `<Suspense>` boundary, so the static shell's 200 is already sent. The private content is never sent to the wrong browser (verified). Moving the check before the shell would make the route fully dynamic.
4. **Next.js telemetry:** `next build` reports that Next.js collects anonymous usage telemetry by default. I didn't change your machine's settings. To opt out, run `npx next telemetry disable`.
5. **Visual review limits:** the in-app browser pane was hidden during testing, which throttles animations in screenshots. All states were also confirmed through computed styles. Please review the motion yourself with `npm run dev`.
6. **`.claude/launch.json`** (the local preview server configuration) was added. It contains no secrets.

## Files added or changed in M1

New: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `AGENTS.md` (Next.js agent notes from the official template), `src/app/{layout,page,not-found}.tsx`, `src/app/globals.css`, `src/app/favicon.ico`, `src/app/api/start/route.ts`, `src/app/start/page.tsx`, `src/app/start/[sessionId]/page.tsx`, `src/components/icons/*`, `src/components/ui/*`, `src/components/motion/Reveal.tsx`, `src/components/landing/*` (10 files), `src/components/onboarding/*` (8 files), `src/lib/cx.ts`, `src/lib/discovery/{message,store}.ts`, `.claude/launch.json`.
Changed: `.gitignore` (`.data/`), `README.md`, `docs/architecture/{README,02,06}.md`.
