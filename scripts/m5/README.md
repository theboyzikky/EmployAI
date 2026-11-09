# M5 owner scripts (NEAR testnet)

Owner-run only, in Git Bash at the repository root, with near-cli-rs signing from **your** OS keychain. Each run requires the matching batch approval, recorded in [`docs/architecture/poc-results/m5-batches.md`](../../docs/architecture/poc-results/m5-batches.md), which has the full B1 and B2 sheets: commands, expected outputs, balances and recovery.

| Script | Batch | Signs? | What it does |
|---|---|---|---|
| `00-precheck.sh` | B1 step 0 | No | Tools; **WASM SHA-256 and size = the reviewed Phase 1 artifact**; names still free (read-only RPC) |
| `01-provision.sh` | B1 | With `--execute` | 5 accounts, deploy and init in one transaction, allowlist 2 suppliers, the agent's restricted key |
| `02-verify.sh` | B1 | No | Code hash, initial state, allowlist and keys (read-only); evidence JSON |
| `03-b2-key-check.sh` | B2 part 1 | No | Proves the exact restricted permission; saves the fixture; finds the key file |
| `04-b2-negative-tests.sh` | B2 part 2 | With `--execute` | 12 transactions that must all fail |
| `emergency.sh` | E (pre-authorised) / normal batch | With `--execute` | `pause` and `revoke-agent-key` are pre-authorised; `unpause` needs a batch |

**Safety:**
- **Dry run by default:** without `--execute`, a script only prints commands; the signing scripts make no network calls at all.
- **With `--execute`:** each transaction asks you to type `YES`.
- **Secrets:** no script reads or writes `.env` or prints a private key.
- **Evidence:** outputs go to `scripts/m5/evidence/` (git-ignored); summaries go into the batch log.
- **Account names** can be overridden with environment variables (`PARENT=…`); see `lib.sh`. Any change needs re-approval.
