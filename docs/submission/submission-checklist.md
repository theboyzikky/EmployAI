# Submission checklist (NEAR HACKATHON)

Checked against the live rules at https://nearhackathon.com/HACKATHON.md on 2026-11-10. Re-read them before submitting; dates and rules may change. **Nothing here is sent automatically.** The owner confirms the full payload before a single submission.

## Requirements vs this project

| Requirement (HACKATHON.md) | Status |
|---|---|
| Public repository by 2026-11-14T23:59Z | ⏳ Owner makes it public (the repo is local and private now; nothing is pushed). |
| README for human and AI judges: what it is, the problem, "do X, see Y" steps, no marketing (Procedure 1, Q-017) | ✅ README.md rewritten 2026-11-10 |
| Libraries, templates and AI tools listed (Q-005) | ✅ README "Libraries and baseline" |
| Pre-hackathon code disclosed (Q-001) | ✅ None; project started 2026-11-03 |
| LICENSE file (Q-014) | ✅ MIT |
| Testnet-only is eligible (Q-010) | ✅ Testnet only |
| Local-only demo: public repo + reproducible README + X post with a **video** (Q-012) | ⏳ Owner records the video (script: [demo-video-script.md](demo-video-script.md)) and publishes the X post |
| Demo post tags @NEARProtocol and #NEARHackathon, with a video | ⏳ Owner; draft text in the script file |
| One submission per project; payload printed and confirmed first | ⏳ Owner confirms; then one POST with one `requestId` |
| No secrets committed | ✅ Secret scan of every commit; `.env` git-ignored |
| Two projects by one person disclosed (Q-015) | Owner to confirm (not applicable unless the lead submits another project) |

## Track evidence

| Track | Evidence | Gap |
|---|---|---|
| `security` (AI Security & Defense: spending limits, policy engines, sandboxed wallets, scam detection, function-call keys) | Deterministic gate; function-call key limited to one method; contract caps (0.1 / 0.25 NEAR); recipient allowlist; owner approval bound to the exact payment; kill switch; shared blocklist with evidence; `npm run demo:attack` (BLOCK, 0 signatures); key-rotation drill on chain (batches E/E2); S5 kill-switch demo with on-chain proof | Part A of the attack demo (a live LLM) not run |
| `business` (AI-native business: treasury, sales, procurement, revenue sharing) | AI team for a business; procurement → supplier payout from an on-chain treasury, verified on testnet twice (B3, S2) | **Sales and revenue sharing (`pay_order`) aren't enabled** (see README Limitations). NEAR Intents not used. |

## Fields the owner decides (never filled in by the assistant)

`projectName`, `leadName`, `email`, `size`, `tracks` (suggested: `["security", "business"]`), `nearAddress` (a **mainnet** account the owner creates), `projectUrl` (the public repo), `demoUrl` (the X post), `consent` (read the notice verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon.").

## Suggested `idea` text (20–2,000 characters; the owner edits it)

> Small-business owners want AI to run routine work, but giving an AI agent money is risky: prompt injection, overspending, wrong recipients, leaked keys. EmployAI is an AI business builder: an owner describes their business, a consultant proposes a team of agents (orchestrator, order, inventory, procurement, finance) and an approved workflow they run. The Finance Agent pays suppliers for real on NEAR testnet, but only through our own treasury contract, which enforces an allowlist of recipients, 0.1 NEAR per payment and 0.25 NEAR per day, and one success per request. The agent signs with a NEAR function-call access key that can call exactly one method (request_payment), so it can't transfer funds, attach deposits or change keys. Before anything is signed, a deterministic security gate checks the recipient, limits, a shared blocklist with evidence and read-only chain checks, and the owner approves the exact payment (bound by hash to recipient, amounts, workflow, policy, contract and code hash). Transactions are saved before sending, unknown outcomes are reconciled from the contract's own record, and "paid" is shown only after on-chain verification. A kill switch stops everything not yet sent. Our attack demo shows a prompt-injected, fully compromised agent trying to pay a known scammer: blocked, no signature, no transaction. Two payouts made through the app and verified on NEAR testnet: AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP and 6BV9JEX2bHkEyyYCbFjyuDJtTca8jLekrRP9TA5JRUC4. Customer sales and revenue sharing are not enabled yet.

## Payload shape (filled only with the owner's answers; never committed)

```json
{"requestId":"<uuid generated once>","projectName":"…","leadName":"…","email":"…","size":"…","tracks":["security","business"],"nearAddress":"…","projectUrl":"…","demoUrl":"…","idea":"…","consent":true}
```
