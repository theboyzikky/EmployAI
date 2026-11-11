// The connection catalogue (provider-independent, data only, no I/O): every provider EmployAI knows
// about, the CAPABILITIES employees ask for, and the PERMISSION categories an owner grants per employee.
//
// Honesty is part of the data. A provider's `support` says what exists in THIS build:
//   implemented      a real connector is registered (it can be connected and used)
//   not_implemented  listed so owners can see the plan; never shown as connectable or working
//   unsupported      no official, permitted way to automate it
// Whether a business has actually CONNECTED a provider comes only from its stored connections.

export type Permission = "read_messages" | "draft_messages" | "send_messages" | "create_content" | "publish_content" | "read_analytics" | "manage";
export const PERMISSIONS: Record<Permission, { label: string; description: string }> = {
  read_messages: { label: "Read messages", description: "Receive incoming messages and enquiries from this account." },
  draft_messages: { label: "Draft messages", description: "Prepare messages for the owner to review (nothing is sent)." },
  send_messages: { label: "Send messages", description: "Send messages or emails from this account (approval rules still apply)." },
  create_content: { label: "Create content", description: "Create drafts or media containers on this account without publishing." },
  publish_content: { label: "Publish content", description: "Publish public posts (each post still needs the owner's approval)." },
  read_analytics: { label: "Read analytics", description: "Read reach, engagement and other statistics." },
  manage: { label: "Other actions", description: "Other permitted actions this integration supports." },
};

/** What an employee asks for. Never a vendor: the integration layer resolves it to a provider and connection. */
export type CapabilityDef = { label: string; permission: Permission; /** Provided by EmployAI itself (no account to connect). */ builtIn?: string };
export const CAPABILITY_DEFS: Record<string, CapabilityDef> = {
  publish_social_post: { label: "Publish social posts", permission: "publish_content" },
  schedule_publication: { label: "Schedule publications", permission: "publish_content", builtIn: "EmployAI background scheduler" },
  read_social_messages: { label: "Read social comments and messages", permission: "read_messages" },
  reply_to_customer: { label: "Reply to customers", permission: "send_messages" },
  reply_to_social_comments: { label: "Reply to social comments", permission: "send_messages" },
  send_message: { label: "Send messages to customers", permission: "send_messages" },
  send_email: { label: "Send email", permission: "send_messages" },
  read_email: { label: "Read email", permission: "read_messages" },
  retrieve_analytics: { label: "Retrieve analytics", permission: "read_analytics" },
  receive_events: { label: "Receive business events", permission: "read_messages" },
  write_records: { label: "Write business records", permission: "manage" },
  manage_calendar: { label: "Manage a calendar", permission: "manage" },
  read_documents: { label: "Read documents", permission: "read_messages" },
  pay_near: { label: "Payments on NEAR", permission: "manage", builtIn: "NEAR treasury contract (testnet), managed in Ledger" },
};

export type ProviderCategory = "social" | "email" | "messaging" | "business";
export type ProviderSupport = "implemented" | "not_implemented" | "unsupported";
export type ProviderAuth = "oauth" | "token" | "signed_webhook";
export type ProviderDef = {
  key: string;
  name: string;
  category: ProviderCategory;
  support: ProviderSupport;
  /** Registered connector key when implemented. */
  connector: string | null;
  /** How the owner connects: OAuth (preferred) and/or pasting a token they generated themselves. */
  auth: ProviderAuth[];
  /** The OAuth flow it uses (src/lib/integrations/oauth.ts), when it has one. */
  oauth?: "instagram" | "google" | "microsoft";
  /** Capabilities this provider offers (or would offer, when not implemented). */
  capabilities: string[];
  /** What has to exist outside EmployAI first (developer app, review, account type…). */
  setup: string;
};

export const PROVIDERS: ProviderDef[] = [
  // Social media
  { key: "instagram", name: "Instagram", category: "social", support: "implemented", connector: "instagram", auth: ["oauth", "token"], oauth: "instagram", capabilities: ["publish_social_post", "reply_to_social_comments", "retrieve_analytics"],
    setup: "An Instagram professional (Business or Creator) account. One-click connect needs a Meta app with Instagram Login (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET); publishing to accounts other than the app's own testers needs Meta App Review. Alternatively paste a token generated in the Meta App Dashboard." },
  { key: "facebook", name: "Facebook Pages", category: "social", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["publish_social_post", "read_social_messages", "reply_to_customer", "reply_to_social_comments", "retrieve_analytics"],
    setup: "Not built yet. Needs a Meta app with Facebook Login for Business, Page permissions and Meta App Review." },
  { key: "tiktok", name: "TikTok", category: "social", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "Not built yet. Needs a TikTok for Developers app with the Content Posting API; public posting requires TikTok's app audit." },
  { key: "linkedin", name: "LinkedIn", category: "social", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "Not built yet. Needs a LinkedIn developer app; posting as a company page needs approved Community Management API access." },
  { key: "x", name: "X", category: "social", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["publish_social_post", "read_social_messages", "reply_to_customer"],
    setup: "Not built yet. Needs an X developer account and an API access tier that allows posting." },
  { key: "youtube", name: "YouTube", category: "social", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "Not built yet. Needs a Google Cloud project with the YouTube Data API; the upload scope requires Google's app verification." },
  // Email
  { key: "gmail", name: "Gmail", category: "email", support: "implemented", connector: "gmail", auth: ["oauth"], oauth: "google", capabilities: ["send_email", "send_message"],
    setup: "Needs a Google Cloud OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) with the Gmail API enabled and this app's callback URL. Until Google verifies the app, only accounts added as test users can connect." },
  { key: "outlook", name: "Outlook / Microsoft 365", category: "email", support: "implemented", connector: "outlook", auth: ["oauth"], oauth: "microsoft", capabilities: ["send_email", "send_message"],
    setup: "Needs a Microsoft Entra app registration (MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET) with delegated Mail.Send and this app's callback URL. Some organisations require an admin to consent." },
  { key: "imap_smtp", name: "Other email (IMAP / SMTP)", category: "email", support: "not_implemented", connector: null, auth: ["token"], capabilities: ["send_email", "read_email"],
    setup: "Not built yet. Would use the provider's IMAP/SMTP settings with an app password, never the account's main password." },
  // Messaging
  { key: "whatsapp_business", name: "WhatsApp Business", category: "messaging", support: "not_implemented", connector: null, auth: ["token"], capabilities: ["read_social_messages", "reply_to_customer", "send_message"],
    setup: "Not built yet. Needs the WhatsApp Business Platform (Cloud API): a Meta business account, a registered phone number, and approved message templates for messages outside the 24-hour window." },
  { key: "whatsapp_personal", name: "WhatsApp (personal app)", category: "messaging", support: "unsupported", connector: null, auth: [], capabilities: [],
    setup: "Unsupported: there is no official API for personal WhatsApp accounts. Use WhatsApp Business instead." },
  { key: "telegram", name: "Telegram", category: "messaging", support: "implemented", connector: "telegram", auth: ["token"], capabilities: ["read_social_messages", "reply_to_customer", "send_message"],
    setup: "Create a bot with @BotFather and paste its bot token. Incoming messages need the app at a public https address (EMPLOYAI_PUBLIC_URL) so Telegram can deliver them." },
  { key: "webchat", name: "Website chat", category: "messaging", support: "not_implemented", connector: null, auth: [], capabilities: ["read_social_messages", "reply_to_customer"],
    setup: "Not built yet. Would be an embeddable chat widget served by EmployAI." },
  // Business systems
  { key: "webhook", name: "Signed webhook (any system)", category: "business", support: "implemented", connector: "webhook", auth: ["signed_webhook"], capabilities: ["receive_events", "write_records"],
    setup: "Your system signs events with a secret EmployAI shows once. Works with POS, order, inventory or any custom system." },
  { key: "google_calendar", name: "Google Calendar", category: "business", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["manage_calendar"], setup: "Not built yet. Would reuse the Google OAuth client." },
  { key: "google_drive", name: "Google Drive", category: "business", support: "not_implemented", connector: null, auth: ["oauth"], capabilities: ["read_documents"], setup: "Not built yet. Would reuse the Google OAuth client." },
];

export const providerByKey = (key: string) => PROVIDERS.find(p => p.key === key) ?? null;
export const providerForConnector = (connector: string) => PROVIDERS.find(p => p.connector === connector) ?? null;
export const providersFor = (capability: string) => PROVIDERS.filter(p => p.capabilities.includes(capability));

/** An action's permission category (declared, else derived from its side effect). */
export function permissionOf(spec: { permission?: Permission; sideEffect: string }): Permission {
  if (spec.permission) return spec.permission;
  return spec.sideEffect === "publish" ? "publish_content" : spec.sideEffect === "external_message" ? "send_messages" : spec.sideEffect === "read" ? "read_messages" : "manage";
}
/** Does an action provide a capability? (An action may provide several, e.g. send_email + send_message.) */
export const provides = (spec: { capability?: string | readonly string[] }, capability: string) =>
  Array.isArray(spec.capability) ? spec.capability.includes(capability) : spec.capability === capability;
