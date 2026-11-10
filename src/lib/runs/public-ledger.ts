import "server-only";
// M7 · Public ledger (plan §13; deferred from M5, R10). PRIVATE BY DEFAULT: the owner publishes it, which
// creates an unguessable link, and can unpublish it at any time (the old link then stops working).
// What it shows is limited to facts already public on NEAR testnet: verified on-chain payouts (amount,
// recipient account, transaction hash, time). Never: NGN business amounts, simulated rows, run or request
// IDs, demo data, the owner's profile, failed attempts or anything still in progress.
import { randomBytes } from "node:crypto";
import { nearText } from "./agents";
import { explorerLinks } from "./payment-executor";
import { runRead, runTransact } from "./repo";

export type PublicLedgerView = {
  businessName: string;
  rows: Array<{ amountText: string; recipient: string; txHash: string; explorer: { primary: string; secondary: string }; occurredAt: string }>;
  totalNear: string;
};

const SLUG = /^[A-Za-z0-9_-]{22,64}$/;

export async function setLedgerPublic(businessId: string, publish: boolean): Promise<string | null> {
  return runTransact(tx => {
    const b = tx.business(businessId);
    if (!b) throw new Error("NOT_FOUND");
    // A new slug every time it's published, so an unpublished link never comes back.
    const slug = publish ? (b.public_ledger_slug ?? randomBytes(18).toString("base64url")) : null;
    tx.publishLedgerSlug(businessId, slug);
    tx.appendEvent(businessId, "owner", publish ? "ledger.published" : "ledger.unpublished", `business:${businessId}`, publish ? "public" : "private", businessId, {});
    return slug;
  });
}

export async function publicLedgerBySlug(slug: string): Promise<PublicLedgerView | null> {
  if (!SLUG.test(slug)) return null;
  return runRead(tx => {
    const b = tx.businessByLedgerSlug(slug);
    if (!b) return null;
    const paid = tx.ledger(b.id).filter(l => l.mode === "testnet" && l.tx_status === "confirmed" && !!l.tx_hash)
      .sort((x, y) => y.occurred_at.localeCompare(x.occurred_at));
    const total = paid.reduce((t, l) => t + BigInt(l.amount as string), BigInt(0));
    return {
      businessName: b.name ?? "EmployAI business",
      rows: paid.map(l => ({ amountText: `${nearText(l.amount as string)} NEAR`, recipient: l.counterparty, txHash: l.tx_hash!, explorer: explorerLinks(l.tx_hash!), occurredAt: l.occurred_at })),
      totalNear: nearText(total.toString()),
    };
  });
}
