// Integration layer contract (layer B). A CONNECTOR is a reusable adapter for one external service or
// protocol; a CONNECTION is one business's configured, credentialed instance of a connector. Employees
// are never tied to a connector: an employee is GRANTED actions on any number of connections, and events
// from any connection are ROUTED to employees by event type. Telegram, WhatsApp, email, POS, inventory,
// accounting, supplier platforms and generic webhooks all fit this one shape.
//
// Every connector declares whether it is REAL (reaches the outside world) or SIMULATED (a labelled
// stand-in). Simulated connectors are never evidence of automation and are shown as such.

/** What the connector is for. Informs the UI and defaults; never a security boundary on its own. */
export type ConnectorKind = "communication" | "marketing" | "business_system" | "developer";

/**
 * What an action does to the outside world. Drives the security rules and the retry policy:
 *  - read:              reads external data; safe to retry
 *  - write:             changes data in an external system (stock, orders, CRM records)
 *  - external_message:  sends a message to a person (customer, supplier, owner)
 *  - publish:           publishes public content (a social post) — owner approval is required by default
 *  - money:             moves money — NOT available to connectors: payments go only through the
 *                       existing NEAR treasury path (src/lib/runs/payment-executor.ts)
 */
export type SideEffect = "read" | "write" | "external_message" | "publish";

/**
 * How a repeat of the same action is made safe:
 *  - provider_key: the provider honours an idempotency key we send, so re-sending the SAME key after an
 *                  unknown outcome cannot create a second effect (bounded re-sends allowed)
 *  - none:         no such guarantee: an unknown outcome is NEVER re-sent automatically; it is
 *                  reconciled if the connector can, otherwise escalated to the owner
 */
export type IdempotencySupport = "provider_key" | "none";

/** A normalised inbound event. Its content is UNTRUSTED: it can never authorise anything by itself. */
export type InboundEvent = {
  /** The provider's own id for this event (deduplication key within the connection). */
  externalId: string;
  /** Namespaced type, e.g. "message.received", "order.created", "stock.changed". */
  type: string;
  occurredAt: string | null;
  /** Bounded, JSON-serialisable payload. */
  payload: Record<string, unknown>;
  /** Who the event is about/from on the provider side (chat id, customer id), if any. */
  subject: string | null;
};

export type InboundVerdict =
  | { ok: true; events: InboundEvent[] }
  | { ok: false; status: 400 | 401 | 413; code: string };

/** The outcome of ONE delivery attempt of an outbound action. */
export type ActionOutcome =
  /** The provider confirmed it. `ref` is its id for the effect (message id, record id): the proof. */
  | { kind: "done"; ref: string | null; detail?: string; data?: Record<string, unknown> }
  /** The provider refused BEFORE acting (validation, auth, rate limit). Nothing happened. */
  | { kind: "rejected"; retryable: boolean; code: string; detail: string }
  /** We can't know whether it happened (timeout after sending, 5xx, connection reset mid-request). */
  | { kind: "unknown"; detail: string };

export type ActionContext = {
  businessId: string;
  connectionId: string;
  /** Stable for every delivery attempt of this action (sent as the provider idempotency key). */
  idempotencyKey: string;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
};

export type ActionSpec = {
  sideEffect: SideEffect;
  /** The provider-independent capability (or capabilities) this action implements (e.g. "publish_social_post"). */
  capability?: string | readonly string[];
  /** The owner-facing permission category that grants it (default: derived from sideEffect). */
  permission?: import("./catalogue").Permission;
  idempotency: IdempotencySupport;
  /** Validates and normalises the input; throws on anything unexpected (deterministic, no I/O). */
  parse(input: unknown): Record<string, unknown>;
  execute(ctx: ActionContext, input: Record<string, unknown>): Promise<ActionOutcome>;
  /** Optional: ask the provider whether an action with an unknown outcome happened. */
  reconcile?(ctx: ActionContext, input: Record<string, unknown>): Promise<ActionOutcome | null>;
};

export type ConnectorSetup = {
  /** Non-secret settings, validated (and normalised) by the connector. */
  config: Record<string, unknown>;
  /** Secrets generated or supplied at creation; stored encrypted, shown to the owner ONCE if generated. */
  secrets: Record<string, string>;
  /** Secrets to show the owner once (e.g. a generated signing secret). Never stored in clear. */
  revealOnce: Record<string, string>;
  /** External identities this connection answers for on platform-wide webhooks (verified by setup). */
  routeKeys?: string[];
};

export interface Connector {
  readonly key: string;
  readonly name: string;
  readonly kind: ConnectorKind;
  readonly reality: "real" | "simulated";
  /** Event types this connector can emit (for routing rules). */
  readonly eventTypes: readonly string[];
  readonly actions: Readonly<Record<string, ActionSpec>>;
  /** Build a connection's config and secrets from the owner's input (deterministic + random secrets). */
  setup(input: unknown): Promise<ConnectorSetup> | ConnectorSetup;
  /** Optional: re-check that the stored credentials still work (owner's "Check connection"). */
  checkAuth?(ctx: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }): Promise<{ ok: true; detail?: string } | { ok: false; reauth: boolean; detail: string }>;
  /**
   * Optional: fetch new inbound events (providers without a usable push mechanism, e.g. mailboxes).
   * Run by the durable worker on a schedule; returns events plus the updated cursor stored in config.
   */
  poll?(ctx: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }): Promise<{ events: InboundEvent[]; config: Record<string, unknown> } | { error: "auth" | "temporary"; detail: string }>;
  /** Optional: called once after a connection is created (e.g. register a webhook with the provider). */
  activate?(ctx: { connectionId: string; publicUrl: string | null; config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }): Promise<{ ok: boolean; detail: string }>;
  /** Verify and parse an inbound request. Absent = this connector receives no events. */
  inbound?(req: { rawBody: string; headers: Headers; config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>>; now: number }): InboundVerdict;
}
