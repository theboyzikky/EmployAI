#!/usr/bin/env bash
# B2 part 2 — NEGATIVE TESTS. Owner-run. Every transaction here MUST FAIL.
#  K1–K7: signed with the Finance Agent's RESTRICTED key (from its key file, so no other key can be
#         picked): calls outside its permission must be REJECTED by the network before execution.
#  C1–C5: calls the key IS allowed to make (or owner calls) that the CONTRACT must refuse.
# Any money that could move in a test can only go to owner-controlled accounts (the parent), never to a
# third party. A step that unexpectedly SUCCEEDS stops the script.
# Dry run by default; --execute to sign and send (each step asks for YES).
# Usage: bash scripts/m5/04-b2-negative-tests.sh [--execute]
source "$(dirname "$0")/lib.sh"
need near; need curl; need node

keyfile_path_file="${EVIDENCE_DIR}/B2/.fc-keyfile-path"
if [ -f "$keyfile_path_file" ]; then KEYFILE="$(cat "$keyfile_path_file")"; else KEYFILE="<run 03-b2-key-check.sh first>"; fi
[ "$EXECUTE" -eq 1 ] && { [ -f "$KEYFILE" ] || fail "Key file not found. Run 03-b2-key-check.sh first."; }

# expect_failure <id> <expected-error-substrings (|-separated)> <command...>
# Passes only if the command fails AND its output names one of the expected errors.
results=()
expect_failure() {
  local id="$1" expected="$2"; shift 2
  if [ "$EXECUTE" -ne 1 ]; then run_tx B2 "$id" "$@"; info "expected: fails with one of: $expected"; return 0; fi
  local log status=0
  run_tx B2 "$id" "$@" || status=$?
  log="$(ls -t "${EVIDENCE_DIR}/B2/"*"-${id// /-}.log" 2>/dev/null | head -1)"
  # Classify on the ERROR SECTION only (from near-cli's "Error:" line on, colours stripped), never on the
  # printed transaction, which also contains words such as "deposit" and "receiver_id".
  local errtext; errtext="$(sed "s/$(printf '\033')\[[0-9;?]*[a-zA-Z]//g" "$log" | tr -d '\r' | sed -n '/^Error:/,$p')"
  if [ "$status" -eq 0 ] && ! printf '%s' "$errtext" | grep -qiE "$expected"; then
    results+=("$id UNEXPECTED SUCCESS")
    fail "$id did not fail. STOP: record this and report it before doing anything else."
  fi
  if [ -n "$errtext" ] && printf '%s' "$errtext" | grep -qiE "$expected"; then ok "$id failed as expected"; results+=("$id PASS (failed as expected)")
  else info "$id failed, but not with an expected error. Review $log"; results+=("$id REVIEW (failed with another error)"); fi
}

say "B2 negative tests · $([ "$EXECUTE" -eq 1 ] && echo EXECUTE || echo 'DRY RUN (nothing will be signed)')"
info "restricted key file: $KEYFILE"
SIGN_FC=(network-config "$NETWORK" sign-with-access-key-file "$KEYFILE" send)

# ---- K: restricted-key misuse (expected: rejected by the network, no execution, no gas spent)
expect_failure "K1 set_policy with restricted key" "isn't allowed by the access key|MethodNameMismatch" \
  near contract call-function as-transaction "$TREASURY" set_policy json-args '{"max_per_tx":"1","daily_cap":"1"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "K2 pause with restricted key" "isn't allowed by the access key|MethodNameMismatch" \
  near contract call-function as-transaction "$TREASURY" pause json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "K3 approve_recipient with restricted key" "isn't allowed by the access key|MethodNameMismatch" \
  near contract call-function as-transaction "$TREASURY" approve_recipient json-args "{\"account\":\"$PARENT\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "K4 request_payment with a deposit" 'deposit with a function call action is not allowed|DepositWithFunctionCall' \
  near contract call-function as-transaction "$TREASURY" request_payment \
  json-args "{\"request_id\":\"b2-k4-deposit\",\"recipient\":\"$SUPPLIER_1\",\"amount\":\"1000000000000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "K5 call another contract with restricted key" "doesn't match the access key|ReceiverMismatch" \
  near contract call-function as-transaction "$PARENT" request_payment json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "K6 plain transfer with restricted key" 'requires a full permission access key|RequiresFullAccess' \
  near tokens "$AGENT" send-near "$PARENT" '0.01 NEAR' "${SIGN_FC[@]}"
# K7 tries to add the PARENT's own public key, so even an unexpected success could not hand control to anyone else.
PARENT_PUBKEY="<parent public key>"
if [ "$EXECUTE" -eq 1 ]; then
  PARENT_PUBKEY="$(json_get "$(view_access_key_list "$PARENT")" '(v.result.keys.find(k => k.access_key.permission === "FullAccess") || {}).public_key')"
fi
expect_failure "K7 add-key with restricted key" 'requires a full permission access key|RequiresFullAccess' \
  near account add-key "$AGENT" grant-full-access use-manually-provided-public-key "$PARENT_PUBKEY" "${SIGN_FC[@]}"

# ---- C: contract refusals (the transaction executes and the contract panics; state unchanged; gas burnt)
expect_failure "C1 payout to a non-allowlisted account" 'Smart contract panicked: Recipient not approved' \
  near contract call-function as-transaction "$TREASURY" request_payment \
  json-args "{\"request_id\":\"b2-c1-unapproved\",\"recipient\":\"$PARENT\",\"amount\":\"10000000000000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "C2 payout over the per-payment limit" 'Smart contract panicked: Amount over per-transaction limit' \
  near contract call-function as-transaction "$TREASURY" request_payment \
  json-args "{\"request_id\":\"b2-c2-overlimit\",\"recipient\":\"$SUPPLIER_1\",\"amount\":\"110000000000000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "C3 invalid request id" 'Smart contract panicked: Invalid request_id' \
  near contract call-function as-transaction "$TREASURY" request_payment \
  json-args "{\"request_id\":\"bad\",\"recipient\":\"$SUPPLIER_1\",\"amount\":\"10000000000000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" "${SIGN_FC[@]}"
expect_failure "C4 request_payment by a non-agent (the owner)" 'Smart contract panicked: Not the registered agent' \
  near contract call-function as-transaction "$TREASURY" request_payment \
  json-args "{\"request_id\":\"b2-c4-nonagent\",\"recipient\":\"$SUPPLIER_1\",\"amount\":\"10000000000000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
expect_failure "C5 pay_order while sales are disabled" 'Smart contract panicked: Sales disabled' \
  near contract call-function as-transaction "$TREASURY" pay_order json-args '{"order_id":"b2-c5-order"}' \
  prepaid-gas '100 Tgas' attached-deposit '0.01 NEAR' sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send

# ---- state must be unchanged (read-only)
if [ "$EXECUTE" -eq 1 ]; then
  say "State after B2 (read-only)"
  for id in b2-k4-deposit b2-c1-unapproved b2-c2-overlimit bad b2-c4-nonagent; do
    r="$(view_call "$TREASURY" get_request "{\"request_id\":\"$id\"}")"
    [ "$r" = "null" ] && ok "get_request($id) = null" || fail "get_request($id) = $r (expected null)"
  done
  s="$(json_get "$(view_call "$TREASURY" get_spent_today '{}')" 'v.spent')"
  [ "$s" = "0" ] && ok "spent today = 0" || fail "spent today = $s (expected 0)"
  p="$(view_call "$TREASURY" get_policy '{}')"
  [ "$(json_get "$p" 'v.paused')" = "false" ] && [ "$(json_get "$p" 'v.max_per_tx')" = "$MAX_PER_TX_YOCTO" ] && ok "policy unchanged" || fail "policy changed: $p"
  [ "$(view_call "$TREASURY" is_approved "{\"account\":\"$PARENT\"}")" = "false" ] && ok "parent still not allowlisted" || fail "parent became allowlisted"
  [ "$(json_get "$(view_access_key_list "$AGENT")" 'v.result.keys.length')" = "2" ] && ok "agent still has exactly 2 keys" || fail "agent key count changed"
  for a in "$TREASURY" "$AGENT" "$SUPPLIER_1"; do info "$a: $(near_balance "$a") NEAR"; done
  say "Summary"; for r in "${results[@]}"; do info "$r"; done
  info "Gas per transaction: the C-step logs contain each transaction ID; record gas_burnt in the batch log."
fi
