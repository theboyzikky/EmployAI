import "server-only";
// Registers every REAL connector. Importing this module (API routes, the worker) makes them available
// to the registry; nothing else in the platform names a specific connector. Which providers exist (and
// which are only planned) is listed in ../catalogue.ts.
import { registerConnector } from "../registry";
import "../oauth";                       // registers the OAuth token refresher used before every action
import { gmailConnector, outlookConnector } from "./email";
import { instagramConnector } from "./instagram";
import { facebookConnector, linkedinConnector, tiktokConnector, xConnector, youtubeConnector } from "./social";
import { telegramConnector } from "./telegram";
import { telegramBusinessConnector } from "./telegram-business";
import { webhookConnector } from "./webhook";

registerConnector(webhookConnector);
registerConnector(instagramConnector);
registerConnector(gmailConnector);
registerConnector(outlookConnector);
registerConnector(telegramConnector);
registerConnector(telegramBusinessConnector);
registerConnector(facebookConnector);
registerConnector(linkedinConnector);
registerConnector(xConnector);
registerConnector(tiktokConnector);
registerConnector(youtubeConnector);

export const CONNECTORS_REGISTERED = true;
