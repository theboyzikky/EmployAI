import "server-only";
// Registers every REAL connector. Importing this module (API routes, the worker) makes them available
// to the registry; nothing else in the platform names a specific connector.
// Connectors are added milestone by milestone: the generic signed webhook (P0), Telegram (P1), then
// WhatsApp, email, website chat and business systems (P2) — each on the same contract.
import { registerConnector } from "../registry";
import { webhookConnector } from "./webhook";

registerConnector(webhookConnector);

export const CONNECTORS_REGISTERED = true;
