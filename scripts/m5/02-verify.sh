#!/usr/bin/env bash
# B1 verification — READ-ONLY (public RPC; no signing). Run after 01-provision.sh --execute.
# Checks the deployed code, the initial state, the allowlist and the agent's keys, and saves the
# evidence as JSON. Any mismatch prints STOP: then do not start B2; report instead.
# Usage: bash scripts/m5/02-verify.sh
source "$(dirname "$0")/lib.sh"
need curl; need node
out="$(evidence_file B1 verify.json)"
fails=0
check() { if [ "$2" = "$3" ]; then ok "$1 = $2"; else printf '  \033[31mFAIL\033[0m %s: got %s, expected %s\n' "$1" "$2" "$3"; fails=$((fails+1)); fi; }

say "Treasury code"
acct="$(view_account "$TREASURY")"
check "treasury code_hash" "$(json_get "$acct" 'v.result.code_hash')" "$EXPECTED_CODE_HASH_B58"
info "treasury balance $(near_balance "$TREASURY") NEAR · storage $(json_get "$acct" 'v.result.storage_usage') bytes"

say "Initial state"
policy="$(view_call "$TREASURY" get_policy '{}')"
check "owner"         "$(json_get "$policy" 'v.owner')" "$PARENT"
check "agent"         "$(json_get "$policy" 'v.agent')" "$AGENT"
check "max_per_tx"    "$(json_get "$policy" 'v.max_per_tx')" "$MAX_PER_TX_YOCTO"
check "daily_cap"     "$(json_get "$policy" 'v.daily_cap')" "$DAILY_CAP_YOCTO"
check "paused"        "$(json_get "$policy" 'v.paused')" "false"
check "sales_enabled" "$(json_get "$policy" 'v.sales_enabled')" "false"
sales="$(view_call "$TREASURY" get_sales_config '{}')"
check "sales.enabled" "$(json_get "$sales" 'v.enabled')" "false"
spent="$(view_call "$TREASURY" get_spent_today '{}')"
check "spent today"   "$(json_get "$spent" 'v.spent')" "0"

say "Allowlist"
check "is_approved($SUPPLIER_1)" "$(view_call "$TREASURY" is_approved "{\"account\":\"$SUPPLIER_1\"}")" "true"
check "is_approved($SUPPLIER_2)" "$(view_call "$TREASURY" is_approved "{\"account\":\"$SUPPLIER_2\"}")" "true"
check "is_approved($PARENT) (must stay false)" "$(view_call "$TREASURY" is_approved "{\"account\":\"$PARENT\"}")" "false"

say "Finance Agent keys (expect exactly one restricted key + one full-access recovery key)"
keys="$(view_access_key_list "$AGENT")"
fc_count="$(json_get "$keys" 'v.result.keys.filter(k => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall).length')"
fa_count="$(json_get "$keys" 'v.result.keys.filter(k => k.access_key.permission === "FullAccess").length')"
check "function-call keys on $AGENT" "$fc_count" "1"
check "full-access keys on $AGENT"   "$fa_count" "1"
fc_key="$(json_get "$keys" '(v.result.keys.find(k => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall) || {}).public_key || "none"')"
info "restricted public key: $fc_key (the exact permission is proven in B2)"

say "Balances"
for a in "$PARENT" "$TREASURY" "$AGENT" "$SUPPLIER_1" "$SUPPLIER_2"; do info "$a: $(near_balance "$a") NEAR"; done

node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({checked_at:new Date().toISOString(), rpc:process.argv[2], treasury:process.argv[3], account:JSON.parse(process.argv[4]), policy:JSON.parse(process.argv[5]), sales:JSON.parse(process.argv[6]), spent:JSON.parse(process.argv[7]), agent_keys:JSON.parse(process.argv[8]), failures:Number(process.argv[9])}, null, 2))' \
  "$out" "$RPC_URL" "$TREASURY" "$acct" "$policy" "$sales" "$spent" "$keys" "$fails"
info "evidence: $out"
[ "$fails" -eq 0 ] || fail "$fails check(s) failed. Do not start B2. Report the output above."
say "B1 verified. Next (after your B2 approval): bash scripts/m5/03-b2-key-check.sh"
