#!/usr/bin/env bash
# B1 — ACCOUNT CREATION, DEPLOY-AND-INIT, ALLOWLIST, AGENT KEY. Owner-run only.
# Dry run by default (prints every command). Add --execute to sign and send, one confirmed step at a time.
# Re-running is safe: accounts that already exist are skipped; each transaction asks for YES first.
# Usage: bash scripts/m5/01-provision.sh            (dry run)
#        bash scripts/m5/01-provision.sh --execute  (sign and send)
source "$(dirname "$0")/lib.sh"
need near; need curl; need node; need sha256sum

say "B1 · $([ "$EXECUTE" -eq 1 ] && echo EXECUTE || echo 'DRY RUN (nothing will be signed)')"
info "network $NETWORK · parent $PARENT · treasury $TREASURY · agent $AGENT · suppliers $SUPPLIER_1, $SUPPLIER_2"

# Step 0 · the WASM must be the reviewed artifact, checked again here right before use.
actual_sha="$(sha256sum "$WASM" | cut -d' ' -f1)"
[ "$actual_sha" = "$EXPECTED_WASM_SHA256" ] || fail "WASM SHA-256 $actual_sha is not the reviewed $EXPECTED_WASM_SHA256. Do not deploy."
[ "$(wc -c < "$WASM" | tr -d ' ')" = "$EXPECTED_WASM_SIZE" ] || fail "WASM size differs from the reviewed artifact."
ok "WASM is the reviewed artifact ($EXPECTED_WASM_SHA256)"

create_if_missing() { # create_if_missing <account> <command...>
  local acct="$1"; shift
  if [ "$EXECUTE" -ne 1 ]; then run_tx B1 "create $acct" "$@"; return; fi   # dry run: no network at all
  local rc=0; account_exists "$acct" || rc=$?
  case "$rc" in
    0) ok "$acct already exists; skipping creation" ;;
    1) run_tx B1 "create $acct" "$@" ;;
    *) fail "Could not check $acct (RPC error)." ;;
  esac
}

# Step 1 · parent account from the testnet faucet. Its full-access key goes into YOUR OS keychain.
create_if_missing "$PARENT" \
  near account create-account sponsor-by-faucet-service "$PARENT" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  network-config "$NETWORK" create

# Step 2 · parent balance must cover the sub-accounts (faucet amount is not known in advance).
if [ "$EXECUTE" -eq 1 ]; then
  bal="$(near_balance "$PARENT")" || fail "Could not read the parent balance from RPC after ~30 s. Stop and report; nothing further was sent."
  info "parent balance: $bal NEAR (need at least $PARENT_MIN_NEAR)"
  node -e 'process.exit(Number(process.argv[1]) >= Number(process.argv[2]) ? 0 : 1)' "$bal" "$PARENT_MIN_NEAR" \
    || fail "Parent has $bal NEAR; at least $PARENT_MIN_NEAR NEAR is needed. Stop and report (no paid funding)."
  ok "parent balance sufficient"
else
  info "(dry run) would require the parent to hold at least $PARENT_MIN_NEAR NEAR before continuing"
fi

# Step 3 · sub-accounts, funded by the parent. Each full-access key goes into YOUR OS keychain.
create_if_missing "$TREASURY" \
  near account create-account fund-myself "$TREASURY" "$TREASURY_BALANCE" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
create_if_missing "$AGENT" \
  near account create-account fund-myself "$AGENT" "$AGENT_BALANCE" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
create_if_missing "$SUPPLIER_1" \
  near account create-account fund-myself "$SUPPLIER_1" "$SUPPLIER_BALANCE" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
create_if_missing "$SUPPLIER_2" \
  near account create-account fund-myself "$SUPPLIER_2" "$SUPPLIER_BALANCE" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send

# Step 4 · deploy AND initialise in ONE transaction (plan C8), signed by the treasury account's own key.
# Refuses if the treasury already has code: no in-place redeploys (R6).
code_hash="none"
if [ "$EXECUTE" -eq 1 ]; then
  code_hash="$(json_get "$(view_account "$TREASURY")" 'v.result ? v.result.code_hash : "none"')" || code_hash="none"
fi
if [ "$code_hash" = "11111111111111111111111111111111" ] || [ "$code_hash" = "none" ]; then
  # Re-check the artifact immediately before deploying (minutes may have passed since step 0).
  [ "$(sha256sum "$WASM" | cut -d' ' -f1)" = "$EXPECTED_WASM_SHA256" ] || fail "WASM changed since step 0. Do not deploy."
  INIT_ARGS="{\"owner\":\"$PARENT\",\"agent\":\"$AGENT\",\"max_per_tx\":\"$MAX_PER_TX_YOCTO\",\"daily_cap\":\"$DAILY_CAP_YOCTO\"}"
  run_tx B1 "deploy and init treasury" \
    near contract deploy "$TREASURY" use-file "$WASM" with-init-call new json-args "$INIT_ARGS" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-keychain send
elif [ "$code_hash" = "$EXPECTED_CODE_HASH_B58" ]; then
  ok "treasury already runs the reviewed code ($code_hash); not redeploying"
else
  fail "treasury has DIFFERENT code ($code_hash). No in-place redeploys (R6): stop and report."
fi

# Step 5 · allowlist the two suppliers (owner method: owner key + exactly 1 yoctoNEAR).
for s in "$SUPPLIER_1" "$SUPPLIER_2"; do
  run_tx B1 "approve recipient $s" \
    near contract call-function as-transaction "$TREASURY" approve_recipient json-args "{\"account\":\"$s\"}" \
    prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$PARENT" network-config "$NETWORK" sign-with-keychain send
done

# Step 6 · the Finance Agent's RESTRICTED key: only treasury.request_payment, unlimited allowance (null),
# signed with the agent's full-access key. The new key is saved to the LEGACY keychain file
# (~/.near-credentials/testnet/...) so B2 can sign with exactly this key and you can copy it into .env
# yourself. If the CLI rejects "--allowance unlimited", STOP: do not substitute a numeric allowance
# (the app's verifier accepts only a null allowance).
fc_existing=0
if [ "$EXECUTE" -eq 1 ]; then
  fc_existing="$(json_get "$(view_access_key_list "$AGENT")" 'v.result.keys.filter(k => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall).length')"
fi
if [ "$fc_existing" != "0" ]; then
  ok "$AGENT already has a restricted key; not adding another (verify it with 02-verify.sh and B2)"
else
  run_tx B1 "add restricted function-call key to $AGENT" \
    near account add-key "$AGENT" grant-function-call-access --allowance unlimited \
    --contract-account-id "$TREASURY" --function-names request_payment \
    autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config "$NETWORK" sign-with-keychain send
fi

say "B1 commands complete$([ "$EXECUTE" -eq 1 ] || echo ' (dry run)'). Next: bash scripts/m5/02-verify.sh (read-only)."
