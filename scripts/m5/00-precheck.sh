#!/usr/bin/env bash
# B1 step 0 — PRE-CHECKS (no signing, no transactions).
#  1. The tools are present.
#  2. The WASM to deploy is byte-for-byte the reviewed Phase 1 artifact (SHA-256 and size).
#  3. Read-only RPC: the planned account names are still free (time-sensitive, B0-8).
# Usage: bash scripts/m5/00-precheck.sh
source "$(dirname "$0")/lib.sh"

say "1 · Tools"
for t in near curl node sha256sum; do need "$t"; ok "$t found: $(command -v "$t")"; done

say "2 · WASM artifact (must be the reviewed Phase 1 build)"
[ -f "$WASM" ] || fail "WASM not found at $WASM. Do not rebuild it: a rebuild may change the hash. Report this instead."
actual_sha="$(sha256sum "$WASM" | cut -d' ' -f1)"
actual_size="$(wc -c < "$WASM" | tr -d ' ')"
info "file:     $WASM"
info "sha256:   $actual_sha"
info "expected: $EXPECTED_WASM_SHA256"
info "size:     $actual_size bytes (expected $EXPECTED_WASM_SIZE)"
[ "$actual_sha" = "$EXPECTED_WASM_SHA256" ] || fail "SHA-256 mismatch. This is not the reviewed artifact. Do not deploy."
[ "$actual_size" = "$EXPECTED_WASM_SIZE" ] || fail "Size mismatch. Do not deploy."
ok "WASM matches the reviewed artifact (expected on-chain code_hash after deploy: $EXPECTED_CODE_HASH_B58)"

say "3 · Account names (read-only RPC: $RPC_URL)"
all_free=1
for a in "$PARENT" "$TREASURY" "$AGENT" "$SUPPLIER_1" "$SUPPLIER_2"; do
  rc=0; account_exists "$a" || rc=$?
  case "$rc" in
    0) info "EXISTS  $a"; all_free=0 ;;
    1) ok "free    $a" ;;
    *) fail "Could not determine whether $a exists (RPC error). Try again later; do not proceed." ;;
  esac
done
if [ "$all_free" -eq 1 ]; then
  ok "All five names are free right now. They are not reserved until B1 creates them."
else
  say "Some names already exist."
  info "If you created them in an earlier, interrupted B1 run, 01-provision.sh skips existing accounts."
  info "If you did NOT create them, STOP: the B1 sheet must be revised with new names and re-approved."
fi
