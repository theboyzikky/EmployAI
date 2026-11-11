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
/** oauth: OAuth redirect · external: the provider's own non-OAuth authorization (Telegram Business, WhatsApp Embedded Signup) · token / signed_webhook: developer methods. */
export type ProviderAuth = "oauth" | "external" | "token" | "signed_webhook";
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
  oauth?: "instagram" | "google" | "microsoft" | "facebook" | "linkedin" | "x" | "tiktok";
  /** Capabilities this provider offers (or would offer, when not implemented). */
  capabilities: string[];
  /** The subset EmployAI's connector really performs in this build (checked against the connector by tests). */
  works?: string[];
  /** What EmployAI actually reads from the account once connected (nothing else). */
  reads?: string[];
  /** What has to exist outside EmployAI first (developer app, review, account type…). */
  setup: string;
};

export const PROVIDERS: ProviderDef[] = [
  // Social media
  { key: "instagram", reads: ["Account username and type","Recent posts (only to confirm a publication)"], works: ["publish_social_post"], name: "Instagram", category: "social", support: "implemented", connector: "instagram", auth: ["oauth", "token"], oauth: "instagram", capabilities: ["publish_social_post", "reply_to_social_comments", "retrieve_analytics"],
    setup: "An Instagram professional (Business or Creator) account. One-click connect needs a Meta app with Instagram Login (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET); publishing to accounts other than the app's own testers needs Meta App Review. Alternatively paste a token generated in the Meta App Dashboard." },
  { key: "facebook", reads: ["Pages you manage (to pick the business Page)","Recent Page posts (only to confirm a publication)"], works: ["publish_social_post"], name: "Facebook Pages", category: "social", support: "implemented", connector: "facebook", auth: ["oauth"], oauth: "facebook", capabilities: ["publish_social_post", "reply_to_social_comments", "retrieve_analytics"],
    setup: "One-click connect needs a Meta app with Facebook Login (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET) and this app's callback URL. The owner picks the business Page when Facebook asks. Pages of people other than the app's testers need Meta App Review for pages_manage_posts." },
  { key: "tiktok", reads: ["Display name"], name: "TikTok", category: "social", support: "implemented", connector: "tiktok", auth: ["oauth"], oauth: "tiktok", capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "One-click connect needs a TikTok for Developers app with Login Kit and the Content Posting API (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET). Posts stay private until TikTok audits the app. Posting from EmployAI isn't built yet." },
  { key: "linkedin", reads: ["Name"], name: "LinkedIn", category: "social", support: "implemented", connector: "linkedin", auth: ["oauth"], oauth: "linkedin", capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "One-click connect needs a LinkedIn developer app with Sign In with LinkedIn (OpenID Connect) and Share on LinkedIn (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET). Tokens last 60 days, then the owner reconnects. Posting from EmployAI isn't built yet." },
  { key: "x", reads: ["Username"], name: "X", category: "social", support: "implemented", connector: "xcom", auth: ["oauth"], oauth: "x", capabilities: ["publish_social_post", "read_social_messages", "reply_to_customer"],
    setup: "One-click connect needs an X developer app with OAuth 2.0 (X_CLIENT_ID / X_CLIENT_SECRET) and an API access tier that allows posting. Posting from EmployAI isn't built yet." },
  { key: "youtube", reads: ["Channel name"], name: "YouTube", category: "social", support: "implemented", connector: "youtube", auth: ["oauth"], oauth: "google", capabilities: ["publish_social_post", "retrieve_analytics"],
    setup: "One-click connect uses the Google OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) with the YouTube Data API enabled; the upload scope needs Google's app verification for public use. Uploading videos from EmployAI isn't built yet." },
  // Email
  { key: "gmail", reads: ["Email address", "New messages in your inbox (not promotions, newsletters or automated mail)"], works: ["send_email", "send_message", "read_email", "reply_to_customer"], name: "Gmail", category: "email", support: "implemented", connector: "gmail", auth: ["oauth"], oauth: "google", capabilities: ["send_email", "send_message", "read_email", "reply_to_customer"],
    setup: "Needs a Google Cloud OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) with the Gmail API and this app's callback URL. Reading the inbox uses gmail.readonly, a Google restricted scope: until Google verifies the app (including a security assessment), only test users can connect. New mail is checked by the background worker every few minutes." },
  { key: "outlook", reads: ["Email address", "New messages in your Focused inbox"], works: ["send_email", "send_message", "read_email", "reply_to_customer"], name: "Outlook / Microsoft 365", category: "email", support: "implemented", connector: "outlook", auth: ["oauth"], oauth: "microsoft", capabilities: ["send_email", "send_message", "read_email", "reply_to_customer"],
    setup: "Needs a Microsoft Entra app registration (MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET) with delegated Mail.Send and Mail.Read and this app's callback URL. Some organisations require an admin to consent. New mail is checked by the background worker every few minutes." },
  { key: "imap_smtp", name: "Other email (IMAP / SMTP)", category: "email", support: "not_implemented", connector: null, auth: ["token"], capabilities: ["send_email", "read_email"],
    setup: "Not built yet. Would use the provider's IMAP/SMTP settings with an app password, never the account's main password." },
  // Messaging
  { key: "whatsapp_business", reads: ["Your WhatsApp Business number and name", "Messages customers send to that number"], works: ["read_social_messages", "reply_to_customer"], name: "WhatsApp Business", category: "messaging", support: "implemented", connector: "whatsapp", auth: ["external"], capabilities: ["read_social_messages", "reply_to_customer", "send_message"],
    setup: "Connect opens Meta's own WhatsApp sign-up window (Embedded Signup): the owner signs in to Facebook, chooses or creates the WhatsApp Business account and number, and approves. The operator needs a Meta app with WhatsApp and Facebook Login for Business (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET), an Embedded Signup configuration (WHATSAPP_CONFIG_ID), the app webhook at /api/hooks/meta (META_WEBHOOK_VERIFY_TOKEN), and Meta business verification / Tech Provider status to onboard other businesses. Replies outside 24 hours need approved templates (not built)." },
  { key: "whatsapp_personal", name: "WhatsApp (personal app)", category: "messaging", support: "unsupported", connector: null, auth: [], capabilities: [],
    setup: "Unsupported: there is no official API for personal WhatsApp accounts. Use WhatsApp Business instead." },
  { key: "instagram_dm", reads: ["Account username", "Direct messages customers send to the account"], works: ["read_social_messages", "reply_to_customer"], name: "Instagram Direct Messages", category: "messaging", support: "implemented", connector: "instagram_dm", auth: ["oauth"], oauth: "instagram", capabilities: ["read_social_messages", "reply_to_customer"],
    setup: "One-click connect uses the Instagram app (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET) with instagram_business_manage_messages and the app webhook at /api/hooks/meta (META_WEBHOOK_VERIFY_TOKEN, \"messages\" field). Accounts other than the app's testers need Meta App Review. Replies are allowed within 24 hours of the customer's last message." },
  { key: "messenger", reads: ["Pages you manage (to pick the business Page)", "Messenger messages customers send to the Page"], works: ["read_social_messages", "reply_to_customer"], name: "Facebook Messenger", category: "messaging", support: "implemented", connector: "messenger", auth: ["oauth"], oauth: "facebook", capabilities: ["read_social_messages", "reply_to_customer"],
    setup: "One-click connect uses the Meta app with Facebook Login (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET), permissions pages_messaging and pages_manage_metadata, and the app webhook at /api/hooks/meta (\"messages\" field on Page). Pages of people other than the app's testers need Meta App Review. Replies are allowed within 24 hours of the customer's last message." },
  { key: "linkedin_messaging", name: "LinkedIn messaging", category: "messaging", support: "unsupported", connector: null, auth: [], capabilities: [],
    setup: "Unsupported for now: LinkedIn's messaging APIs are only available to approved LinkedIn partners." },
  { key: "telegram", reads: ["Your Telegram name", "Messages customers send to your Telegram business account"], works: ["read_social_messages", "reply_to_customer"], name: "Telegram", category: "messaging", support: "implemented", connector: "telegram_business", auth: ["external"], capabilities: ["read_social_messages", "reply_to_customer", "send_message"],
    setup: "Connect opens Telegram: tap Start in EmployAI's bot, then add it under Settings → Telegram Business → Chatbots and allow it to reply (Telegram shows the permissions). Needs Telegram Premium on the owner's account. The operator creates the bot once with @BotFather, turns on Business Mode, sets TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME / TELEGRAM_WEBHOOK_SECRET and registers the webhook (scripts/telegram-bot-setup.mjs)." },
  { key: "webchat", name: "Website chat", category: "messaging", support: "not_implemented", connector: null, auth: [], capabilities: ["read_social_messages", "reply_to_customer"],
    setup: "Not built yet. Would be an embeddable chat widget served by EmployAI." },
  // Business systems
  { key: "webhook", reads: ["Events your system sends"], works: ["receive_events","write_records"], name: "Signed webhook (any system)", category: "business", support: "implemented", connector: "webhook", auth: ["signed_webhook"], capabilities: ["receive_events", "write_records"],
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
