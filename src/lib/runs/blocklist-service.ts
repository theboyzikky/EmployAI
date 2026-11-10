import "server-only";
// M6 · Shared blocklist service (requirement X2d; API doc §4). Reports need evidence; the server computes
// its SHA-256 and records which workspace reported it. A new report is "reported" (WARN only) and
// expires after 30 days unless confirmed by the platform reviewer (not built in this prototype).
import { ServiceError } from "@/lib/discovery/service";
import { ACCOUNT_ID, BLOCKLIST_FIXTURES, REPORT_TTL_MS, effectiveStatus, evidenceSha256, type BlocklistReport, type EvidenceType } from "@/lib/security/blocklist";
import { runRead, runTransact } from "./repo";

export type BlocklistEntryView = {
  id: string; accountId: string; status: string; reason: string; evidenceType: EvidenceType; evidenceRef: string; evidenceSha256: string;
  demo: boolean; reportedByYou: boolean; createdAt: string; expiresAt: string | null;
};

const MAX_REPORTS_PER_DAY = 20;

function viewOf(r: BlocklistReport, businessId: string, nowIso: string): BlocklistEntryView {
  return {
    id: r.id, accountId: r.account_id, status: effectiveStatus(r, nowIso), reason: r.reason, evidenceType: r.evidence_type, evidenceRef: r.evidence_ref,
    evidenceSha256: r.evidence_sha256, demo: r.demo, reportedByYou: r.reported_by_business_id === businessId, createdAt: r.created_at, expiresAt: r.expires_at,
  };
}

export function listBlocklist(businessId: string): Promise<BlocklistEntryView[]> {
  return runRead(tx => [...BLOCKLIST_FIXTURES, ...tx.blocklistReports()].map(r => viewOf(r, businessId, tx.now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

function validate(input: { accountId: string; reason: string; evidence: { type: EvidenceType; ref: string } }) {
  const accountId = input.accountId.trim().toLowerCase();
  if (!ACCOUNT_ID.test(accountId) || !accountId.endsWith(".testnet")) throw new ServiceError("VALIDATION_FAILED", 400, "Give a NEAR testnet account ID, e.g. someone.testnet.");
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 200) throw new ServiceError("VALIDATION_FAILED", 400, "Give a short reason (3–200 characters).");
  const ref = input.evidence.ref.trim();
  const ok = input.evidence.type === "tx" ? /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(ref)
    : input.evidence.type === "url" ? /^https:\/\/[^\s]{4,500}$/.test(ref)
    : ref.length >= 10 && ref.length <= 1000;
  if (!ok) throw new ServiceError("VALIDATION_FAILED", 400, input.evidence.type === "tx" ? "Evidence must be a NEAR transaction hash." : input.evidence.type === "url" ? "Evidence must be an https link." : "Describe the evidence (10–1,000 characters).");
  return { accountId, reason, type: input.evidence.type, ref };
}

/** Report an account with evidence. Idempotent per workspace and account while the report is open. */
export async function reportAccount(businessId: string, input: { accountId: string; reason: string; evidence: { type: EvidenceType; ref: string } }): Promise<{ entry: BlocklistEntryView; created: boolean }> {
  const v = validate(input);
  const out = await runTransact(tx => {
    if (!tx.business(businessId)) return { err: ["NOT_FOUND", 404, "Not found."] as const };
    const mine = tx.blocklistReports().filter(r => r.reported_by_business_id === businessId);
    const open = mine.find(r => r.account_id === v.accountId && effectiveStatus(r, tx.now) === "reported");
    if (open) return { entry: viewOf(open, businessId, tx.now), created: false };
    if (mine.filter(r => r.created_at.slice(0, 10) === tx.now.slice(0, 10)).length >= MAX_REPORTS_PER_DAY) return { err: ["RATE_LIMITED", 429, "Too many reports today."] as const };
    const rec = tx.insertBlocklistReport({
      account_id: v.accountId, network: "testnet", status: "reported", reason: v.reason, evidence_type: v.type, evidence_ref: v.ref,
      evidence_sha256: evidenceSha256(v.type, v.ref), reported_by_business_id: businessId, demo: false, reviewed_at: null,
      expires_at: new Date(Date.parse(tx.now) + REPORT_TTL_MS).toISOString(),
    });
    tx.appendEvent(businessId, "owner", "blocklist.reported", `account:${rec.account_id}`, "reported", businessId, { evidence_type: rec.evidence_type, evidence_sha256: rec.evidence_sha256 });
    return { entry: viewOf(rec, businessId, tx.now), created: true };
  });
  if ("err" in out && out.err) throw new ServiceError(out.err[0], out.err[1], out.err[2]);
  return out as { entry: BlocklistEntryView; created: boolean };
}
