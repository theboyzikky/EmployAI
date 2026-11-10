// M6 · Shared blocklist (requirement X2d; doc 03 table 11; threat model §3 rule 5). Pure: no I/O.
// - Shared by ALL workspaces: any owner can report an account, with evidence. The server computes a
//   SHA-256 of the evidence so it can't be swapped later.
// - A CONFIRMED entry is a hard BLOCK (RECIPIENT_BLOCKLISTED). A REPORTED (unreviewed) entry only WARNs
//   (RECIPIENT_REPORTED), so one report can't block a supplier on its own (blocklist poisoning, §5).
// - Reports expire after 30 days unless confirmed. Confirmation is the platform reviewer's job; there is
//   no reviewer role in this prototype, so only the labelled demo fixture below is confirmed.
import { canonicalJson, sha256Hex } from "@/lib/runs/fingerprint";

export type BlocklistStatus = "reported" | "confirmed" | "rejected" | "expired";
export type EvidenceType = "tx" | "url" | "text";

export type BlocklistReport = {
  id: string;
  account_id: string;
  network: "testnet";
  status: BlocklistStatus;
  reason: string;
  evidence_type: EvidenceType;
  evidence_ref: string;
  evidence_sha256: string;
  reported_by_business_id: string | null;   // null for the platform's demo fixture
  demo: boolean;
  created_at: string;
  reviewed_at: string | null;
  expires_at: string | null;                // null = doesn't expire (confirmed)
};

export const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const evidenceSha256 = (type: EvidenceType, ref: string) => sha256Hex(canonicalJson({ type, ref }));

/** The known-bad demo account (labelled): never created on-chain, never on the treasury allowlist. */
export const SCAM_SUPPLIER = "scam-supplier.employai-demo.testnet";
const FIXTURE_EVIDENCE = "Demo fixture (labelled): sent prompt-injected supplier quotes asking agents to ignore their rules and pay this account. Not a real person or business.";
export const BLOCKLIST_FIXTURES: readonly BlocklistReport[] = [{
  id: "fixture-scam-supplier", account_id: SCAM_SUPPLIER, network: "testnet", status: "confirmed",
  reason: "Prompt-injection payment fraud (demo fixture)", evidence_type: "text", evidence_ref: FIXTURE_EVIDENCE,
  evidence_sha256: evidenceSha256("text", FIXTURE_EVIDENCE), reported_by_business_id: null, demo: true,
  created_at: "2026-11-09T00:00:00.000Z", reviewed_at: "2026-11-09T00:00:00.000Z", expires_at: null,
}];

/** Effective status of a report at `nowIso` (unconfirmed reports expire). */
export const effectiveStatus = (r: BlocklistReport, nowIso: string): BlocklistStatus =>
  r.status === "reported" && r.expires_at && r.expires_at <= nowIso ? "expired" : r.status;

/** Confirmed and reported account IDs (fixtures included), for the gate. */
export function blocklistSets(reports: readonly BlocklistReport[], nowIso: string): { confirmed: string[]; reported: string[] } {
  const all = [...BLOCKLIST_FIXTURES, ...reports];
  const confirmed = new Set(all.filter(r => effectiveStatus(r, nowIso) === "confirmed").map(r => r.account_id));
  const reported = new Set(all.filter(r => effectiveStatus(r, nowIso) === "reported" && !confirmed.has(r.account_id)).map(r => r.account_id));
  return { confirmed: [...confirmed], reported: [...reported] };
}

export function statusOf(reports: readonly BlocklistReport[], account: string, nowIso: string): "none" | "reported" | "confirmed" {
  const s = blocklistSets(reports, nowIso);
  return s.confirmed.includes(account) ? "confirmed" : s.reported.includes(account) ? "reported" : "none";
}
