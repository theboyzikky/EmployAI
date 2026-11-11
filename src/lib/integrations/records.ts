// Stored records of the integration layer (one business partition each; see src/lib/store/partition.ts).
// Type-only module: no runtime imports, so the store and the migration script can share it.

/** AES-256-GCM ciphertext of a connection's secrets (src/lib/integrations/credentials.ts). */
export type EncryptedBlob = { v: 1; alg: "A256GCM"; iv: string; tag: string; ct: string };

/** Which employee may use which actions of this connection (owner-granted). `agent` is a catalogue agent key or a workforce employee id. */
export type ConnectionGrant = { agent: string; actions: string[] };
/** Which employee receives which event types from this connection. */
export type ConnectionRoute = { event_type: string; agent: string };

export type ConnectionRecord = {
  /** Unguessable (144 bits); appears in the webhook URL. */
  id: string;
  business_id: string;
  connector: string;
  label: string;
  /**
   *  active           usable (subject to grants)
   *  disabled         paused by the owner
   *  reauth_required  the provider refused the credentials (revoked, expired beyond refresh, missing scopes)
   *  disconnected     the owner disconnected it: credentials deleted, grants cleared
   *  pending          the owner started an external authorization that hasn't finished yet (e.g. Telegram)
   */
  status: "active" | "disabled" | "reauth_required" | "disconnected" | "pending";
  /**
   * External identities this connection answers for on platform-wide webhooks ("meta:page:<id>",
   * "meta:ig:<id>", "meta:wa:<phone_number_id>", "tg:bc:<business_connection_id>"). One external account
   * belongs to at most one business at a time.
   */
  route_keys?: string[];
  /** How it was authorised and what we know about the credential (never the credential itself). */
  auth?: ConnectionAuth;
  reality: "real" | "simulated";
  /** Non-secret settings only. */
  config: Record<string, unknown>;
  /** Encrypted; NEVER returned by any API or view. */
  secrets: EncryptedBlob | null;
  grants: ConnectionGrant[];
  routes: ConnectionRoute[];
  created_at: string;
  updated_at: string;
};

export type ConnectionAuth = {
  method: "oauth" | "token" | "signed_webhook";
  /** Account shown to the owner (username, email address, bot name). */
  account: string | null;
  /** Scopes the provider actually granted (OAuth). */
  scopes: string[];
  /** When the current access token expires (null = no known expiry). */
  expires_at: string | null;
  /** True when EmployAI can renew the token without the owner. */
  refreshable: boolean;
  /** Why the owner must reconnect (when status is reauth_required). */
  problem: string | null;
  checked_at: string | null;
};

export type InboundEventStatus = "received" | "routed" | "unrouted" | "ignored";
export type InboundEventRecord = {
  id: string;
  business_id: string;
  connection_id: string;
  connector: string;
  /** Provider's id; unique per connection (duplicates are dropped). */
  external_id: string;
  type: string;
  subject: string | null;
  payload: Record<string, unknown>;
  occurred_at: string | null;
  received_at: string;
  /** Inbound content can never authorise anything by itself. */
  provenance: "untrusted";
  status: InboundEventStatus;
  routed_to: string | null;
  note: string | null;
};

/**
 * One outbound action (a durable, write-ahead record, like a payment attempt). Statuses:
 *  prepared → sending → done | rejected | unknown → (reconciled) done | rejected | escalated
 *  aborted:   stopped before anything was sent (kill switch, paused employee, revoked grant)
 *  escalated: outcome unknown and not safely repeatable: the owner decides; never re-sent automatically
 */
export type ActionStatus = "prepared" | "sending" | "done" | "rejected" | "unknown" | "aborted" | "escalated";
export type ActionAttemptRecord = {
  id: string;
  business_id: string;
  connection_id: string;
  action: string;
  agent: string;
  /** Unique per business: the same logical action is recorded once (and sent as the provider key). */
  idempotency_key: string;
  input: Record<string, unknown>;
  status: ActionStatus;
  /** Delivery attempts made (each one recorded BEFORE it is made). */
  deliveries: number;
  provider_ref: string | null;
  /** Provider data recorded with a confirmed outcome (e.g. a permalink). */
  result?: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  /** Earliest time a retryable rejection may be retried. */
  retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  /** Correlation: the run, event or task that asked for it. */
  correlation_id: string;
  created_at: string;
  updated_at: string;
};
