#!/usr/bin/env node
// Migration and rollback between the local development store (.data/dev-store.json) and the hosted
// demo's shared store (Upstash Redis). Plain Node, no dependencies. NEVER writes the local store file.
//
//   node scripts/shared-store-migrate.mjs plan   [--file .data/dev-store.json]
//       Dry run, no network: what would be copied (counts, bytes, checksum).
//   node --env-file=<file with UPSTASH_REDIS_REST_URL/TOKEN> scripts/shared-store-migrate.mjs apply [--file …] [--only <businessId,…>]
//       Copies businesses into the shared store. Each business is written with MSETNX (all-or-nothing,
//       and ONLY if the key doesn't exist yet): nothing already in the shared store is ever overwritten.
//       Then reads every written document back and compares it byte for byte.
//   node --env-file=<…> scripts/shared-store-migrate.mjs export --out <new file>
//       Rollback / backup: reads every business from the shared store into a NEW dev-store file
//       (refuses to overwrite an existing file).
//
// The partitioning below mirrors src/lib/store/partition.ts (tests/shared-store-migrate.test.ts proves
// they produce identical documents).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BY_BUSINESS = ["messages", "agents", "workflows", "runs", "security_decisions", "approval_requests", "ledger_entries", "activity_events", "testnet_batches", "payment_attempts", "connections", "inbound_events", "action_attempts", "tasks", "content_items"];
const DAY_MS = 86_400_000;

export const keys = {
  business: id => `biz:${id}`,
  shared: "shared",
  owner: h => `owner:${h}`,
  slug: s => `slug:${s}`,
};

/** The documents a dev-store state becomes in the shared store. Pure; no I/O. */
export function planFromDevState(state, { only = null } = {}) {
  const ids = Object.keys(state.businesses ?? {}).filter(id => !only || only.includes(id));
  const businesses = ids.map(id => {
    const runs = (state.runs ?? {})[id] ?? [];
    const run_steps = {};
    for (const r of runs) { const st = (state.run_steps ?? {})[r.id]; if (st) run_steps[r.id] = st; }
    const part = { business: state.businesses[id] };
    for (const c of BY_BUSINESS) part[c] = (state[c] ?? {})[id] ?? [];
    part.run_steps = run_steps;
    // Same field order as extractBusiness (the documents are compared as JSON).
    const doc = {
      business: part.business, messages: part.messages, agents: part.agents, workflows: part.workflows, runs: part.runs, run_steps,
      security_decisions: part.security_decisions, approval_requests: part.approval_requests, ledger_entries: part.ledger_entries,
      activity_events: part.activity_events, testnet_batches: part.testnet_batches, payment_attempts: part.payment_attempts,
      connections: part.connections, inbound_events: part.inbound_events, action_attempts: part.action_attempts, tasks: part.tasks,
      content_items: part.content_items,
    };
    return { id, ownerHash: state.businesses[id].owner_hash, slug: state.businesses[id].public_ledger_slug ?? null, doc: JSON.stringify(doc) };
  });
  const shared = JSON.stringify({ blocklist_reports: state.blocklist_reports ?? [] });
  const bytes = businesses.reduce((n, b) => n + b.doc.length, shared.length);
  const checksum = createHash("sha256").update(businesses.map(b => b.doc).join("\n") + "\n" + shared).digest("hex");
  return { businesses, shared, stats: { businesses: businesses.length, bytes, checksum, largestDocBytes: Math.max(0, ...businesses.map(b => b.doc.length)) } };
}

/** Apply a plan. `client.cmd(args)` sends one Redis command. Never overwrites an existing key. */
export async function applyPlan(client, plan, { ttlDays = 60, includeShared = true } = {}) {
  const ttl = String(ttlDays * DAY_MS);
  const report = { written: [], skippedExisting: [], slugConflicts: [], shared: "skipped", verified: 0, mismatched: [] };
  for (const b of plan.businesses) {
    const k = keys.business(b.id);
    const ok = Number(await client.cmd(["MSETNX", k, b.doc, `${k}:v`, "1"]));
    if (ok !== 1) { report.skippedExisting.push(b.id); continue; }
    await client.cmd(["PEXPIRE", k, ttl]);
    await client.cmd(["PEXPIRE", `${k}:v`, ttl]);
    await client.cmd(["SADD", keys.owner(b.ownerHash), b.id]);
    await client.cmd(["PEXPIRE", keys.owner(b.ownerHash), ttl]);
    if (b.slug) {
      const s = await client.cmd(["SET", keys.slug(b.slug), b.id, "NX", "PX", ttl]);
      if (s !== "OK") report.slugConflicts.push(b.id);
    }
    report.written.push(b.id);
  }
  if (includeShared) {
    const ok = Number(await client.cmd(["MSETNX", keys.shared, plan.shared, `${keys.shared}:v`, "1"]));
    report.shared = ok === 1 ? "written" : "existing kept (not merged)";
  }
  // Read back every document written and compare byte for byte.
  for (const b of plan.businesses.filter(x => report.written.includes(x.id))) {
    const [doc] = await client.cmd(["MGET", keys.business(b.id)]);
    if (doc === b.doc) report.verified++; else report.mismatched.push(b.id);
  }
  return report;
}

/** Read every business from the shared store back into a dev-store state (rollback / backup). */
export async function exportToDevState(client) {
  const state = { version: 2, businesses: {}, messages: {}, agents: {}, workflows: {}, runs: {}, run_steps: {}, security_decisions: {}, approval_requests: {}, ledger_entries: {}, activity_events: {}, testnet_batches: {}, payment_attempts: {}, connections: {}, inbound_events: {}, action_attempts: {}, tasks: {}, content_items: {}, blocklist_reports: [] };
  const found = new Set();
  let cursor = "0";
  do {
    const [next, batch] = await client.cmd(["SCAN", cursor, "MATCH", "biz:*", "COUNT", "200"]);
    cursor = String(next);
    for (const k of batch) if (!k.endsWith(":v")) found.add(k);
  } while (cursor !== "0");
  const list = [...found];
  for (let i = 0; i < list.length; i += 50) {
    const docs = await client.cmd(["MGET", ...list.slice(i, i + 50)]);
    for (const raw of docs) {
      if (typeof raw !== "string") continue;
      const p = JSON.parse(raw);
      const id = p.business.id;
      state.businesses[id] = p.business;
      for (const c of BY_BUSINESS) state[c][id] = p[c] ?? [];
      Object.assign(state.run_steps, p.run_steps ?? {});
    }
  }
  const [shared] = await client.cmd(["MGET", keys.shared]);
  if (typeof shared === "string") state.blocklist_reports = JSON.parse(shared).blocklist_reports ?? [];
  return state;
}

/** A minimal Upstash REST client (one command per request). Never prints the token or answers. */
export function upstashClient({ url, token, prefix = "eai:" }) {
  if (!url || !token) throw new Error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN).");
  if (!url.startsWith("https://")) throw new Error("The Upstash REST URL must use https.");
  const keyed = new Set(["MSETNX", "PEXPIRE", "SADD", "SET", "MGET", "SMEMBERS"]);
  return {
    async cmd(args) {
      let a = args.map(String);
      if (keyed.has(a[0])) {
        // Prefix the key arguments: every key for MGET; keys at even offsets for MSETNX; the first otherwise.
        a = a[0] === "MGET" ? [a[0], ...a.slice(1).map(k => prefix + k)]
          : a[0] === "MSETNX" ? [a[0], ...a.slice(1).map((x, i) => (i % 2 === 0 ? prefix + x : x))]
          : [a[0], prefix + a[1], ...a.slice(2)];
      }
      if (a[0] === "SCAN") a = a.map((x, i) => (i > 0 && a[i - 1] === "MATCH" ? prefix + x : x));
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error !== undefined) throw new Error(`Upstash refused ${a[0]} (HTTP ${res.status}).`);
      let r = body.result;
      if (a[0] === "SCAN") r = [r[0], r[1].map(k => k.slice(prefix.length))];
      return r;
    },
  };
}

// ---- CLI ---------------------------------------------------------------------------------------------
async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const file = opt("file") ?? ".data/dev-store.json";
  const env = process.env;
  const client = () => upstashClient({ url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN, prefix: env.EMPLOYAI_KV_PREFIX || "eai:" });
  if (cmd === "plan" || cmd === "apply") {
    const raw = readFileSync(file, "utf8");   // read only
    const fileSha = createHash("sha256").update(raw).digest("hex");
    const only = opt("only")?.split(",").filter(Boolean) ?? null;
    const plan = planFromDevState(JSON.parse(raw), { only });
    console.log(JSON.stringify({ file, fileSha256: fileSha, ...plan.stats, blocklistReports: JSON.parse(plan.shared).blocklist_reports.length }, null, 2));
    if (cmd === "plan") { console.log("Dry run: nothing was written."); return; }
    const report = await applyPlan(client(), plan, { ttlDays: Number(env.EMPLOYAI_WORKSPACE_TTL_DAYS) || 60 });
    console.log(JSON.stringify({ written: report.written.length, skippedExisting: report.skippedExisting, slugConflicts: report.slugConflicts, shared: report.shared, verified: report.verified, mismatched: report.mismatched }, null, 2));
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== fileSha) throw new Error("The local file changed during migration (it is never written by this script).");
    if (report.mismatched.length) process.exitCode = 1;
    return;
  }
  if (cmd === "export") {
    const out = opt("out");
    if (!out) throw new Error("--out <new file> is required.");
    if (existsSync(out)) throw new Error(`${out} already exists; choose a new file (this script never overwrites).`);
    const state = await exportToDevState(client());
    writeFileSync(out, JSON.stringify(state), { flag: "wx" });
    console.log(JSON.stringify({ out, businesses: Object.keys(state.businesses).length, blocklistReports: state.blocklist_reports.length }, null, 2));
    return;
  }
  console.log("Usage: plan | apply | export (see the header of this file).");
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("shared-store-migrate.mjs")) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
