#!/usr/bin/env bash
# Shared settings and helpers for the M5 owner scripts. Sourced by every script; does nothing on its own.
#
# SAFETY MODEL
#  - Every script is a DRY RUN unless you pass --execute: it prints the exact commands and runs nothing
#    that signs. Read-only RPC queries (curl) run in both modes only where a script says so.
#  - With --execute, each transaction step asks you to type YES before it runs.
#  - These scripts never read or write .env and never print private keys.
#  - Signing uses YOUR NEAR CLI (near-cli-rs) keychain. Nothing here is ever run by EmployAI or by Claude.
set -euo pipefail

# ------------------------------------------------------------------ configuration (override with env vars)
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://test.rpc.fastnear.com}"
PARENT="${PARENT:-employai-demo.testnet}"
TREASURY="${TREASURY:-treasury.${PARENT}}"
AGENT="${AGENT:-finance-agent.${PARENT}}"
SUPPLIER_1="${SUPPLIER_1:-supplier-1.${PARENT}}"
SUPPLIER_2="${SUPPLIER_2:-supplier-2.${PARENT}}"
export NETWORK RPC_URL PARENT TREASURY AGENT SUPPLIER_1 SUPPLIER_2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WASM="${WASM:-${REPO_ROOT}/contracts/treasury/target/near/employai_treasury.wasm}"
# The Phase 1 artifact the owner reviewed (2026-11-09). Deployment refuses any other file.
EXPECTED_WASM_SHA256="fb79aad928a80ab14aaa17fa7e06e2b4ba5a90d0d7d76a004c389ae81c4504ad"
EXPECTED_WASM_SIZE=174359
EXPECTED_CODE_HASH_B58="HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt"

# Limits from the M5 plan (R16), in yoctoNEAR: 0.1 NEAR per payment, 0.25 NEAR per day.
MAX_PER_TX_YOCTO="100000000000000000000000"
DAILY_CAP_YOCTO="250000000000000000000000"

# Initial balances for sub-accounts created by the parent (B1).
TREASURY_BALANCE="${TREASURY_BALANCE:-2.5 NEAR}"   # ≈1.75 NEAR contract storage + state + ≈0.7 NEAR payout float
AGENT_BALANCE="${AGENT_BALANCE:-0.5 NEAR}"         # gas only; worst case ≈0.01 NEAR per payment
SUPPLIER_BALANCE="${SUPPLIER_BALANCE:-0.1 NEAR}"    # existence only
PARENT_MIN_NEAR="${PARENT_MIN_NEAR:-3.6}"           # parent must hold at least this before creating sub-accounts

EVIDENCE_DIR="${REPO_ROOT}/scripts/m5/evidence"

# Optional, OFF by default: M5_RESTRICT_NEAR_CLI_NETWORK=1 lets near-cli reach ONLY the hosts it needs for
# B1/B2 (its testnet RPC and the faucet helper, from the local near-cli config.toml). Everything else,
# including its GitHub update check, goes to a closed local port and fails on this machine. Applies to
# near-cli commands only (not to these scripts' own read-only curl checks). Untested for signing commands;
# if near-cli cannot reach the RPC it fails before sending anything.
NEAR_CLI_ALLOWED_HOSTS="${NEAR_CLI_ALLOWED_HOSTS:-archival-rpc.testnet.fastnear.com,helper.nearprotocol.com}"
with_net_policy() {
  if [ "${M5_RESTRICT_NEAR_CLI_NETWORK:-0}" = "1" ]; then
    local blackhole="http://127.0.0.1:9"
    env HTTPS_PROXY="$blackhole" HTTP_PROXY="$blackhole" ALL_PROXY="$blackhole" \
        https_proxy="$blackhole" http_proxy="$blackhole" all_proxy="$blackhole" \
        NO_PROXY="$NEAR_CLI_ALLOWED_HOSTS" no_proxy="$NEAR_CLI_ALLOWED_HOSTS" "$@"
  else
    "$@"
  fi
}

# ------------------------------------------------------------------ mode
EXECUTE=0
for arg in "$@"; do [ "$arg" = "--execute" ] && EXECUTE=1; done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[32mOK\033[0m %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is not installed or not on PATH."; }

evidence_file() { # evidence_file <batch> <name>
  mkdir -p "${EVIDENCE_DIR}/$1"
  printf '%s/%s/%s-%s' "${EVIDENCE_DIR}" "$1" "$(date -u +%Y%m%dT%H%M%SZ)" "$2"
}

# run_tx <batch> <step-name> <command...>
# Dry run: print the command. Execute: print it, require YES, run it, keep its output as evidence.
run_tx() {
  local batch="$1" step="$2"; shift 2
  say "[$batch] $step"
  printf '  $'; printf ' %q' "$@"; printf '\n'
  if [ "$EXECUTE" -ne 1 ]; then info "(dry run: not executed)"; return 0; fi
  local answer
  read -r -p "  Type YES to sign and send this transaction: " answer </dev/tty
  [ "$answer" = "YES" ] || fail "Not confirmed. Nothing was sent for: $step"
  local log; log="$(evidence_file "$batch" "${step// /-}.log")"
  [ "${M5_RESTRICT_NEAR_CLI_NETWORK:-0}" = "1" ] && info "near-cli network restricted to: $NEAR_CLI_ALLOWED_HOSTS"
  set +e
  with_net_policy "$@" 2>&1 | tee "$log"
  local status=${PIPESTATUS[0]}
  set -e
  info "Exit status ${status}; output kept in ${log}"
  return "$status"
}

# ------------------------------------------------------------------ read-only RPC helpers (curl + node)
rpc() { # rpc <json-body> → raw JSON response
  curl -sS --max-time 20 -H 'Content-Type: application/json' -d "$1" "$RPC_URL"
}
view_account() { rpc "{\"jsonrpc\":\"2.0\",\"id\":\"m5\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}"; }
view_access_key_list() { rpc "{\"jsonrpc\":\"2.0\",\"id\":\"m5\",\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}"; }
view_access_key() { rpc "{\"jsonrpc\":\"2.0\",\"id\":\"m5\",\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$1\",\"public_key\":\"$2\"}}"; }
# view_call <contract> <method> <json-args> → the method's JSON result (decoded)
view_call() {
  local args_b64; args_b64="$(printf '%s' "$3" | base64 | tr -d '\n')"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":\"m5\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"${args_b64}\"}}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.error||!r.result||r.result.error){console.log(JSON.stringify({error:r.error||r.result?.error||"no result"}));process.exit(2)}console.log(Buffer.from(r.result.result).toString("utf8"))})'
}
# json_get <json> <js-expression on v> → value printed (e.g. json_get "$x" 'v.result.code_hash')
json_get() { node -e 'const v=JSON.parse(process.argv[1]);const r=(new Function("v","return ("+process.argv[2]+")"))(v);console.log(typeof r==="string"?r:JSON.stringify(r))' "$1" "$2"; }
account_exists() { # 0 = exists, 1 = UNKNOWN_ACCOUNT, 2 = unclear (stop)
  local r; r="$(view_account "$1")"
  if [ "$(json_get "$r" 'v.result ? "yes" : (v.error && v.error.cause && v.error.cause.name === "UNKNOWN_ACCOUNT" ? "no" : "unclear")')" = "yes" ]; then return 0; fi
  if [ "$(json_get "$r" 'v.error && v.error.cause && v.error.cause.name === "UNKNOWN_ACCOUNT" ? "no" : "unclear"')" = "no" ]; then return 1; fi
  return 2
}
near_balance() { # liquid balance in NEAR (4 decimals). Retries while a just-created account is not yet
  # visible at final finality; returns non-zero (never crashes) if it never appears or the RPC errors.
  local r end=$((SECONDS + 30))
  while :; do
    r="$(view_account "$1" || true)"
    if [ "$(json_get "$r" 'v.result && typeof v.result.amount === "string" ? "ok" : "no"' 2>/dev/null)" = "ok" ]; then
      json_get "$r" '(Number(BigInt(v.result.amount) / 100000000000000000000n) / 10000).toFixed(4)'
      return 0
    fi
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 5
  done
}
