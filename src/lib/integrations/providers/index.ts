import "server-only";
// Registers every REAL connector. Importing this module (API routes, the worker) makes them available
// to the registry; nothing else in the platform names a specific connector. Which providers exist (and
// which are only planned) is listed in ../catalogue.ts.
import { registerConnector } from "../registry";
import "../oauth";                       // registers the OAuth token refresher used before every action
import { gmailConnector, outlookConnector } from "./email";
import { instagramConnector } from "./instagram";
import { telegramConnector } from "./telegram";
import { webhookConnector } from "./webhook";

registerConnector(webhookConnector);
registerConnector(instagramConnector);
registerConnector(gmailConnector);
registerConnector(outlookConnector);
registerConnector(telegramConnector);

export const CONNECTORS_REGISTERED = true;
