#!/usr/bin/env bash
# Owner emergency procedure (M5 plan §14, docs/architecture/05-threat-model.md §5a). Owner-run only.
#   pause             — treasury.pause() with the owner's key and 1 yoctoNEAR. PRE-AUTHORISED (batch E, O3).
#   revoke-agent-key  — delete the Finance Agent's restricted key with its full-access recovery key.
#                       PRE-AUTHORISED (batch E, O3).
#   unpause           — NOT pre-authorised: needs a normal written batch approval first.
# Record every use afterwards in docs/architecture/poc-results/m5-batches.md (batch E, with hashes).
# Dry run by default; --execute to sign and send.
# Usage: bash scripts/m5/emergency.sh pause|revoke-agent-key|unpause [--execute]
source "$(dirname "$0")/lib.sh"
need near; need curl; need node
action="${1:-}"

case "$action" in
  pause)
    run_tx E "pause treasury" \
      near contract call-function as-transaction "$TREASURY" pause json-args '{}' prepaid-gas '30 Tgas' \
      attached-deposit '1 yoctoNEAR' sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
    [ "$EXECUTE" -eq 1 ] && info "paused now: $(json_get "$(view_call "$TREASURY" get_policy '{}')" 'v.paused')" ;;
  revoke-agent-key)
    fc_key="<restricted public key>"
    if [ "$EXECUTE" -eq 1 ]; then
      fc_key="$(json_get "$(view_access_key_list "$AGENT")" '(v.result.keys.find(k => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall) || {}).public_key || ""')"
      [ -n "$fc_key" ] || fail "No restricted key found on $AGENT (already revoked?)."
    fi
    run_tx E "revoke agent restricted key" \
      near account delete-keys "$AGENT" public-keys "$fc_key" network-config "$NETWORK" sign-with-keychain send
    [ "$EXECUTE" -eq 1 ] && info "keys on $AGENT now: $(json_get "$(view_access_key_list "$AGENT")" 'v.result.keys.length')" ;;
  unpause)
    info "Unpause is NOT part of the pre-authorised emergency procedure: it needs a written batch approval first."
    run_tx UNPAUSE "unpause treasury" \
      near contract call-function as-transaction "$TREASURY" unpause json-args '{}' prepaid-gas '30 Tgas' \
      attached-deposit '1 yoctoNEAR' sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send ;;
  *) fail "Usage: bash scripts/m5/emergency.sh pause|revoke-agent-key|unpause [--execute]" ;;
esac
