// The judge-facing notices appear on the hosted demo (shared store) and not in local development.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {} }) }));
import { Hero } from "@/components/landing/Hero";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { buildRunsView } from "@/lib/runs/view";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant } from "./helpers/run-fixture";

afterEach(() => { vi.unstubAllEnvs(); setKvForTests(null); setDiscoveryRepository(null); });

describe("hosted demo notices", () => {
  test("privacy notice under the hero chat: only on the hosted demo", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("EMPLOYAI_REQUIRE_SHARED_STORE", "");
    expect(renderToStaticMarkup(createElement(Hero))).not.toContain("Public demo:");
    vi.stubEnv("EMPLOYAI_REQUIRE_SHARED_STORE", "true");
    const html = renderToStaticMarkup(createElement(Hero));
    expect(html).toContain("Public demo:");
    expect(html).toContain("stored in this demo&#x27;s database for up to 60 days");
    expect(html).toContain("sent to NEAR AI");
    expect(html).toContain("testnet tokens only");
  });

  test("the Runs view tells the testnet panel it is the shared, public demo (and the per-workspace allowance)", async () => {
    const kv = new MemoryKv();
    setKvForTests(kv);
    const store = new RedisStore(kv);
    setDiscoveryRepository(store);
    const { businessId } = await readyRestaurant(store);
    const b = (await store.getBusiness(businessId))!;
    expect((await buildRunsView(b)).testnet).toMatchObject({ hostedDemo: false, runsPerDay: null });
    vi.stubEnv("EMPLOYAI_REQUIRE_SHARED_STORE", "true");
    expect((await buildRunsView(b)).testnet).toMatchObject({ hostedDemo: true, runsPerDay: 4 });
  });
});
