// The connector registry: the ONE place the platform looks up connectors. Adding an integration means
// adding a connector module and registering it here — no change to the inbox, the action executor, the
// automation engine, routing or the security rules (tests/integrations-core.test.ts checks this shape).
import type { Connector } from "./types";

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const ACTION = /^[a-z][a-z0-9_]{1,47}\.[a-z][a-z0-9_]{1,47}$/;   // "<connector>.<verb>" e.g. "webhook.deliver"

const shapeOf = (c: Connector) => JSON.stringify([c.key, c.name, c.kind, c.reality, c.eventTypes, Object.entries(c.actions).map(([n, a]) => [n, a.sideEffect, a.idempotency]), !!c.inbound]);

const REGISTRY = Symbol.for("employai.connectors");
const g = globalThis as unknown as { [REGISTRY]?: Map<string, Connector> };
const connectors: Map<string, Connector> = (g[REGISTRY] ??= new Map());

/** Register a connector. Its shape is checked: a malformed connector is a programming error. */
export function registerConnector(c: Connector): void {
  if (!KEY.test(c.key)) throw new Error(`connector key "${c.key}" is invalid`);
  if (c.reality !== "real" && c.reality !== "simulated") throw new Error(`connector ${c.key} must declare reality`);
  for (const [name, a] of Object.entries(c.actions)) {
    if (!ACTION.test(name) || !name.startsWith(`${c.key}.`)) throw new Error(`action "${name}" must be named "${c.key}.<verb>"`);
    if (!["read", "write", "external_message", "publish"].includes(a.sideEffect)) throw new Error(`action ${name}: unknown side effect`);
    if (!["provider_key", "none"].includes(a.idempotency)) throw new Error(`action ${name}: unknown idempotency support`);
  }
  // Next bundles route modules separately, so the SAME connector module can register more than once
  // per process (identical shape): that is allowed. A DIFFERENT connector can never take an existing key.
  const existing = connectors.get(c.key);
  if (existing && existing !== c && shapeOf(existing) !== shapeOf(c)) throw new Error(`connector ${c.key} is already registered`);
  connectors.set(c.key, c);
}

export function connectorFor(key: string): Connector | null { return connectors.get(key) ?? null; }
export function listConnectors(): Connector[] { return [...connectors.values()]; }

/** The connector that owns an action name ("webhook.deliver" → webhook). */
export function actionSpec(action: string) {
  const c = connectorFor(action.split(".")[0] ?? "");
  const spec = c?.actions[action];
  return c && spec ? { connector: c, spec } : null;
}

/** Tests only. */
export function unregisterConnectorForTests(key: string) { connectors.delete(key); }
