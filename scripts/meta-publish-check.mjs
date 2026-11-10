#!/usr/bin/env node
// Meta access check (one real Instagram publication). Plain Node, no dependencies. Run it in YOUR terminal:
// the access token is read from the environment and is never printed, logged or saved.
//
//   1. check    node scripts/meta-publish-check.mjs check
//               Confirms the token works and shows which Instagram account it publishes to. Posts nothing.
//   2. publish  node scripts/meta-publish-check.mjs publish
//               Publishes ONE image post: create container → wait until FINISHED → publish → permalink.
//
// Environment (set in the same terminal; never paste the token into a chat):
//   IG_ACCESS_TOKEN   Instagram User access token (App Dashboard → Instagram → API setup with Instagram login)
//   IMAGE_URL         a public https URL of a JPEG you own (publish only)
//   CAPTION           optional caption (publish only)
//   GRAPH_VERSION     optional, default v27.0
const token = process.env.IG_ACCESS_TOKEN ?? "";
const version = process.env.GRAPH_VERSION || "v27.0";
const base = `https://graph.instagram.com/${version}`;
const mode = process.argv[2];

const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch { fail(`Couldn't reach ${base} (network). Nothing was published by this step.`); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    // Meta's error message, type and code only (it never contains the token).
    fail(`Meta refused ${method} ${path.split("?")[0]} (HTTP ${res.status}): ${e.message ?? "no message"}${e.type ? ` [${e.type}` : ""}${e.code ? ` code ${e.code}` : ""}${e.error_subcode ? ` subcode ${e.error_subcode}` : ""}${e.type ? "]" : ""}`);
  }
  return json;
}

async function whoAmI() {
  const me = await api("GET", "/me?fields=user_id,username,account_type");
  if (!me.user_id) fail("The token didn't return an Instagram account id (user_id).");
  return me;
}

async function main() {
  if (mode !== "check" && mode !== "publish") fail("Usage: node scripts/meta-publish-check.mjs check | publish");
  if (token.length < 20) fail("IG_ACCESS_TOKEN isn't set in this terminal. Set it first (see the instructions).");

  console.log(`\nInstagram API ${version}`);
  const me = await whoAmI();
  console.log(`✓ Token works. Account: @${me.username} (id ${me.user_id}${me.account_type ? `, ${me.account_type}` : ""})`);
  if (me.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(me.account_type)) console.log("  ! This doesn't look like a Business/Creator account; publishing needs a professional account.");
  if (mode === "check") { console.log("\nCheck only: nothing was posted.\n"); return; }

  const imageUrl = process.env.IMAGE_URL ?? "";
  if (!/^https:\/\//.test(imageUrl)) fail("IMAGE_URL must be a public https URL of a JPEG.");
  // Instagram only accepts JPEG and fetches it itself: check that it's reachable and really a JPEG first.
  let head;
  try { head = await fetch(imageUrl, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20_000) }); } catch { fail("IMAGE_URL couldn't be downloaded. It must be publicly reachable."); }
  const type = head.headers.get("content-type") ?? "";
  if (!head.ok) fail(`IMAGE_URL answered HTTP ${head.status}. It must be publicly reachable.`);
  if (!/image\/jpe?g/i.test(type)) fail(`IMAGE_URL is "${type || "unknown type"}", not a JPEG. Instagram only accepts JPEG images.`);
  console.log(`✓ Image is a reachable JPEG.`);

  const caption = process.env.CAPTION || "Testing automated publishing with EmployAI.";
  const container = await api("POST", `/${me.user_id}/media`, { image_url: imageUrl, caption });
  console.log(`✓ Media container created (${container.id}). Waiting for Instagram to process it…`);

  let status = "IN_PROGRESS";
  for (let i = 0; i < 20 && status === "IN_PROGRESS"; i++) {
    await sleep(i < 6 ? 10_000 : 30_000);
    status = (await api("GET", `/${container.id}?fields=status_code`)).status_code ?? "UNKNOWN";
    console.log(`  status: ${status}`);
  }
  if (status !== "FINISHED") fail(`The container didn't become ready (status ${status}). Nothing was published.`);

  const published = await api("POST", `/${me.user_id}/media_publish`, { creation_id: container.id });
  console.log(`✓ PUBLISHED. Media id: ${published.id}`);

  const media = await api("GET", `/${published.id}?fields=permalink,timestamp,media_type`);
  console.log(`✓ Permalink: ${media.permalink ?? "(not returned)"}  (${media.media_type ?? "?"}, ${media.timestamp ?? "?"})`);
  console.log("\nNext: send the permalink (NOT the token) so it can be checked from a logged-out browser.\n");
}

main().catch(() => fail("Unexpected error. Nothing more was attempted."));
