#!/usr/bin/env bash
# B2 part 1 — RESTRICTED KEY PROOF. READ-ONLY (public RPC; no signing).
# Captures the exact view_access_key response for the Finance Agent's function-call key (B0-3) and
# checks it strictly: FunctionCall { receiver_id: treasury, method_names: ["request_payment"],
# allowance: null }. FullAccess or anything else → STOP. The saved response becomes the fixture the
# app's key verifier must pass against (Phase 3). It also finds the legacy-keychain file holding this
# key for 04-b2-negative-tests.sh, WITHOUT printing the private key.
# Usage: bash scripts/m5/03-b2-key-check.sh
source "$(dirname "$0")/lib.sh"
need curl; need node

keys="$(view_access_key_list "$AGENT")"
fc_key="$(json_get "$keys" '(v.result.keys.filter(k => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall)).map(k => k.public_key).join(",")')"
[ -n "$fc_key" ] || fail "No function-call key on $AGENT."
case "$fc_key" in *,*) fail "More than one function-call key on $AGENT ($fc_key). Expected exactly one.";; esac

say "view_access_key for $AGENT / $fc_key"
resp="$(view_access_key "$AGENT" "$fc_key")"
fixture="$(evidence_file B2 finance-agent-view_access_key.json)"
printf '%s\n' "$resp" > "$fixture"
verdict="$(json_get "$resp" '
  (() => {
    const r = v.result;
    if (!r) return "FAIL: RPC error " + JSON.stringify(v.error);
    if (r.error) return "FAIL: key missing (" + r.error + ")";
    const p = r.permission;
    if (p === "FullAccess") return "FAIL: FullAccess is never accepted";
    if (!p || typeof p !== "object" || !p.FunctionCall) return "FAIL: unexpected permission " + JSON.stringify(p);
    const f = p.FunctionCall;
    if (f.receiver_id !== process.env.TREASURY) return "FAIL: receiver " + f.receiver_id;
    if (JSON.stringify(f.method_names) !== JSON.stringify(["request_payment"])) return "FAIL: methods " + JSON.stringify(f.method_names);
    if (f.allowance !== null) return "FAIL: allowance " + JSON.stringify(f.allowance) + " (must be null)";
    return "PASS";
  })()')"
info "response saved: $fixture"
[ "$verdict" = "PASS" ] || fail "$verdict"
ok "exact restricted permission proven on-chain: FunctionCall(receiver_id=$TREASURY, method_names=[request_payment], allowance=null)"

say "Legacy keychain file for this key (used by 04 to sign with exactly this key)"
keyfile="$(node -e '
  const fs = require("fs"), path = require("path"), os = require("os");
  const base = path.join(os.homedir(), ".near-credentials", process.argv[1]);
  const acct = process.argv[2], want = process.argv[3];
  const candidates = [path.join(base, acct + ".json")];
  const dir = path.join(base, acct);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) candidates.push(path.join(dir, f));
  for (const c of candidates) {
    try { const j = JSON.parse(fs.readFileSync(c, "utf8")); if (j.public_key === want) { console.log(c); process.exit(0); } } catch {}
  }
  process.exit(1);' "$NETWORK" "$AGENT" "$fc_key")" || fail "No legacy-keychain file holds $fc_key. Locate it (see the B2 sheet, recovery R-B2-1) before running 04."
ok "key file: $keyfile (private key not printed)"
printf '%s\n' "$keyfile" > "${EVIDENCE_DIR}/B2/.fc-keyfile-path"
say "Next: bash scripts/m5/04-b2-negative-tests.sh   (dry run first, then --execute)"
