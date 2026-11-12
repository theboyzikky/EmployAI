// M5 · Static guards for the chain layer. Revised at CP-2 (signer): signing is now allowed, but only
// inside two files, and nothing outside the chain layer can reach it yet (Phase 4 wires it in).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap(f => {
  const p = path.join(dir, f);
  return statSync(path.join(root, p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const chainDir = path.join("src", "lib", "chain");
const chainFiles = walk("src/lib/chain");
const allSrc = walk("src");
const nonChain = allSrc.filter(f => !f.startsWith(chainDir));
const chain = (name: string) => path.join(chainDir, name);
const matching = (files: string[], re: RegExp) => files.filter(f => re.test(read(f))).sort();

describe("chain layer static guards", () => {
  it("every chain module is server-only", () => {
    for (const f of chainFiles) expect([f, read(f).startsWith('import "server-only";')]).toEqual([f, true]);
  });

  it("only keys.ts reads the Finance Agent private key", () => {
    expect(matching(allSrc, /NEAR_FINANCE_AGENT_PRIVATE_KEY/)).toEqual([chain("keys.ts")]);
  });

  it("only keys.ts parses secret key material", () => {
    expect(matching(allSrc, /fromSecretKey|KeyPair\.from|secretKey|privateKey|seedPhrase|parseSeedPhrase/)).toEqual([chain("keys.ts")]);
  });

  it("signing happens only in keys.ts (the key) and signer.ts (the wrapper)", () => {
    // (the runner reaches signing only through the injected PaymentChain port's `sign`, never a primitive)
    expect(matching(allSrc, /signTransaction|signAndSend|signDelegate|signMessage/)).toEqual([chain("keys.ts"), chain("signer.ts")]);
  });

  it("near-api-js is used only inside the chain layer, and only by keys.ts and signer.ts", () => {
    expect(matching(allSrc, /near-api-js|@near-js\//)).toEqual([chain("keys.ts"), chain("signer.ts")]);
  });

  it("transactions are submitted only through rpc.ts (send_tx), never broadcast_tx", () => {
    expect(matching(allSrc, /"send_tx"/)).toEqual([chain("rpc.ts")]);
    expect(matching(allSrc, /\.sendTx\(/)).toEqual([chain("signer.ts")]);
    expect(matching(allSrc, /broadcast_tx/)).toEqual([]);
  });

  it("the signer never uses a full-access path: no FullAccess grant, add-key, deploy or transfer actions", () => {
    const signer = read(chain("signer.ts"));
    expect(signer).not.toMatch(/actions\.(transfer|addKey|addFullAccessKey|addFunctionCallAccessKey|deleteKey|deployContract|deleteAccount|stake|createAccount)/);
    expect(signer.match(/actions\.\w+/g)).toEqual(["actions.functionCall"]);
    expect(signer).toContain('"request_payment"');
  });

  it("the chain layer never logs (no key, signature or transaction leaks to logs)", () => {
    expect(matching(chainFiles, /console\./)).toEqual([]);
  });

  it("nothing outside the chain layer imports the signer or the key loader (the runner uses the port)", () => {
    expect(matching(nonChain, /@\/lib\/chain\/(signer|keys)|chain\/(signer|keys)"/)).toEqual([]);
  });

  it("only the chain layer talks to NEAR RPC: no other module imports the RPC client", () => {
    for (const f of nonChain) expect([f, /@\/lib\/chain\/rpc|\.\/rpc"/.test(read(f))]).toEqual([f, false]);
  });

  it("client components and pages never import the chain layer; API routes import only the live port registration", () => {
    const api = path.join("src", "app", "api");
    for (const f of [...walk("src/components"), ...walk("src/app").filter(x => !x.startsWith(api))]) expect([f, /@\/lib\/chain/.test(read(f))]).toEqual([f, false]);
    for (const f of walk("src/app/api")) {
      const imports = read(f).match(/@\/lib\/chain\/[\w-]+/g) ?? [];
      expect([f, imports.every(i => i === "@/lib/chain/live")]).toEqual([f, true]);
    }
    // start, advance, approval decision, payment retry, and the background worker (P0: runs continue
    // without the browser; it drives the same runner, approvals and fenced signer — no new signing path)
    expect(matching(walk("src/app/api"), /@\/lib\/chain\/live/).sort()).toEqual([
      "src/app/api/w/[id]/approvals/[approvalId]/route.ts", "src/app/api/w/[id]/runs/[runId]/advance/route.ts",
      "src/app/api/w/[id]/runs/[runId]/payment/retry/route.ts", "src/app/api/w/[id]/runs/route.ts", "src/app/api/worker/route.ts",
    ].map(p => p.split("/").join(path.sep)).sort());
  });

  it("the runner reaches the chain only through the injected PaymentChain port", () => {
    const runs = walk("src/lib/runs");
    expect(matching(runs, /@\/lib\/chain|near-api-js|@near-js/)).toEqual([]);
    // only live.ts registers the real port (payment-port.ts merely defines the registry)
    expect(matching(allSrc.filter(f => !f.endsWith("payment-port.ts")), /registerPaymentChainFactory\(/)).toEqual([chain("live.ts")]);
  });

  it("pay_order is unreachable from the app (R9, AC5-14)", () => {
    for (const f of allSrc) expect([f, /pay_order/.test(read(f))]).toEqual([f, false]);
  });

  it("the approved values are pinned in config.ts", () => {
    const c = read("src/lib/chain/config.ts");
    expect(c).toContain('"HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt"');
    expect(c).toContain('agentPublicKey: "ed25519:3WYMJJAsybvTPJHDgeys77PMHARoKKYyFd2iVDBfuRGx"');
    expect(c).not.toMatch(/agentPublicKey: "ed25519:8qgG/);           // the exposed B1 key is never approved again
    expect(c).toContain('treasury: "treasury.employai-demo.testnet"');
    expect(c).toContain('agent: "finance-agent.employai-demo.testnet"');
    expect(c).toContain('owner: "employai-demo.testnet"');
    expect(c).toContain('NEAR_MAX_PER_TX_YOCTO = BigInt("100000000000000000000000")');
    expect(c).toContain('NEAR_DAILY_CAP_YOCTO = BigInt("250000000000000000000000")');
  });

  it("per-process signer guards and the live chain are process-wide (globalThis), not per route bundle", () => {
    expect(read(chain("signer.ts"))).toContain('Symbol.for("employai.signerState")');
    expect(read(chain("live.ts"))).toContain('Symbol.for("employai.liveChain")');
    expect(read(chain("signer.ts"))).not.toMatch(/^const (lastNonce|queues|signedAttempts) = new /m);
  });

  it("near-api-js is pinned to exactly 7.4.0", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["near-api-js"]).toBe("7.4.0");
  });
});
