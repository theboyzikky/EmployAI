#!/usr/bin/env node
// One-time operator setup for EmployAI's Telegram bot (Telegram Business connections). Run it in YOUR
// terminal; the bot token is read from the environment and never printed, logged or saved.
//
//   Before: create the bot with @BotFather (/newbot), then in @BotFather → Bot Settings → Business Mode → Turn on.
//
//   node scripts/telegram-bot-setup.mjs check      Confirms the token and shows the bot's username. Changes nothing.
//   node scripts/telegram-bot-setup.mjs webhook    Registers <EMPLOYAI_PUBLIC_URL>/api/hooks/telegram with the secret token.
//
// Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (1–256 chars of A–Z a–z 0–9 _ -), EMPLOYAI_PUBLIC_URL (https).
const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const mode = process.argv[2];
const fail = msg => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
async function api(method, body) {
  let res;
  try { res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000) }); }
  catch { fail(`Couldn't reach Telegram (${method}).`); }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) fail(`Telegram refused ${method}: ${json.description ?? res.status}`);   // never echoes the token
  return json.result;
}
if (!/^\d{5,12}:[A-Za-z0-9_-]{30,64}$/.test(token)) fail("Set TELEGRAM_BOT_TOKEN in this terminal (from @BotFather). Never paste it into a chat.");
const me = await api("getMe");
console.log(`✓ Bot: @${me.username} (set TELEGRAM_BOT_USERNAME=${me.username})`);
console.log(me.can_connect_to_business === true ? "✓ Business Mode is on" : me.can_connect_to_business === false ? "✗ Business Mode is OFF: @BotFather → Bot Settings → Business Mode → Turn on" : "? Confirm Business Mode is on in @BotFather → Bot Settings → Business Mode");
if (mode === "webhook") {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const base = (process.env.EMPLOYAI_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) fail("Set TELEGRAM_WEBHOOK_SECRET (16+ characters of A–Z a–z 0–9 _ -).");
  if (!/^https:\/\//.test(base)) fail("Set EMPLOYAI_PUBLIC_URL to the deployed https address.");
  await api("setWebhook", { url: `${base}/api/hooks/telegram`, secret_token: secret, allowed_updates: ["message", "business_connection", "business_message"] });
  console.log(`✓ Webhook registered: ${base}/api/hooks/telegram`);
} else if (mode !== "check") {
  console.log("\nUsage: node scripts/telegram-bot-setup.mjs check | webhook");
}
