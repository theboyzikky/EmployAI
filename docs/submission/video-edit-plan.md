# Demo video: edit plan

**Format:** a motion-graphics film with three short real-app clips cut in. No voice and no music. Captions are on screen, so the video works with the sound off.
**Length:** about 2 minutes. **Resolution:** 1920×1080.

## 1. Record the film

1. Start the dev server and open `http://localhost:3101/video/film.html` in Chrome or Edge.
2. Press **F** for fullscreen, then **H** to hide the hint bar. This also hides the cursor.
3. Start your screen recorder (Windows: Snipping Tool, Record), then press **Space** to play.
4. The film runs about 96 seconds, then holds on the last frame. Stop recording.

Other keys: **R** restarts the film. **1–7** jumps to a scene, which is useful for re-recording a single scene.

| # | Scene | Length | What it shows |
|---|-------|--------|---------------|
| 1 | Hook | 9 s | "Give AI agents money. Not the keys to everything." |
| 2 | Problem | 12 s | Prompt injection, overspending, wrong recipients, leaked keys |
| 3 | How it works | 16 s | Describe the business → consultant → 5-agent team → owner-approved workflow |
| 4 | Safety layers | 16 s | Function-call key, treasury contract limits, security gate, hash-bound approval, kill switch |
| 5 | Real payment | 16 s | Finance Agent → gate → approval → sign → treasury → supplier; tx `6BV9JE…JRUC4` |
| 6 | Attack | 16 s | Injected quote → BLOCK (3 reasons) → 0 approvals, 0 signatures, 0 transactions |
| 7 | Outro | 11 s | 2 payouts, 5 layers, 529 tests; GitHub link; @NEARProtocol #NEARHackathon |

## 2. Record three real clips (each 6–10 s)

Record the full browser window at 1920×1080, with the browser zoom at 110–125% so the text is readable.

| Clip | Where | What to do | Caption to add |
|------|-------|------------|----------------|
| **A. Approval card** | Workspace → **Runs**, open a testnet run that is awaiting approval (or arm a new batch) | Hover over the approval card. Show the recipient, amount and the "bound to this payment" line. Don't click **Sign and send** unless you mean to make a real testnet payment. | "The owner approves this exact payment" |
| **B. Paid and verified** | Workspace → **Ledger**, then click the explorer link for tx `6BV9JEX2bHkEyyYCbFjyuDJtTca8jLekrRP9TA5JRUC4` | Show the "Paid · verified on NEAR testnet" row, then the NEAR Rocks page with the 0.031 NEAR transfer | "Real payout, verifiable by anyone on NEAR testnet" |
| **C. Attack blocked** | Terminal in the project folder | Run `npm run demo:attack` and let the green test lines and BLOCK reasons scroll | "A prompt-injected payment is blocked before any signature" |

Clip A shows a pending run. If you have none and don't want to make a new payment, record the run's approved or paid state instead. Show the policy hash and approval details.

## 3. Assemble (Clipchamp, free on Windows 11)

1. Import the film recording and the three clips.
2. Split the film at the scene boundaries (the times are below) and insert the clips:

| After | At (film time) | Insert |
|-------|----------------|--------|
| Scene 4 (safety layers) | 0:53 | Clip A, approval card |
| Scene 5 (real payment) | 1:09 | Clip B, paid and verified |
| Scene 6 (attack) | 1:25 | Clip C, attack blocked |

3. Add each clip's caption as a text overlay: bottom-centre, white text on a dark, semi-transparent box, Manrope or similar.
4. Use simple 0.3 s cross-fades between pieces.
5. Export at 1080p MP4. The total length should be about 2:00.

## 4. Checklist before uploading

- [ ] No `.env`, keys, seed phrases or wallet pop-ups visible in any clip
- [ ] No personal email or browser bookmarks visible (use a clean browser profile or hide the bookmarks bar)
- [ ] All numbers on screen match the README (2 payouts, 529 tests, 0.1 / 0.25 NEAR limits)
- [ ] The "Demo data is fictional · payments are real NEAR testnet transactions" line is visible in the film
- [ ] Upload to YouTube (Unlisted is fine) or X, and put the link in the submission
