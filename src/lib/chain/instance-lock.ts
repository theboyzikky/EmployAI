import "server-only";
// M5 · Single-server guard for testnet signing (plan §10, K9). The local store, the business lock and
// the signer's nonce/duplicate guards are all per-process, so only ONE server process may sign. The
// first process to need the signer takes an exclusive lock file next to the store; another live process
// is refused (TESTNET_SINGLE_SERVER). A lock left by a process that no longer exists is taken over.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

export type InstanceLock = { ok: true; file: string } | { ok: false; code: "TESTNET_SINGLE_SERVER"; message: string };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export function acquireSignerLock(dir = path.join(process.cwd(), ".data")): InstanceLock {
  const file = path.join(dir, "testnet-signer.lock");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      closeSync(fd);
      process.once("exit", () => { try { if (holder(file) === process.pid) rmSync(file); } catch { /* best effort */ } });
      return { ok: true, file };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = holder(file);
      if (pid === process.pid) return { ok: true, file };
      if (pid !== null && alive(pid)) return { ok: false, code: "TESTNET_SINGLE_SERVER", message: `Another EmployAI server process (pid ${pid}) holds the testnet signer. Only one server may sign.` };
      rmSync(file, { force: true });   // stale: its process is gone
    }
  }
  return { ok: false, code: "TESTNET_SINGLE_SERVER", message: "The testnet signer lock couldn't be taken." };
}

function holder(file: string): number | null {
  try { const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid; return typeof pid === "number" ? pid : null; } catch { return null; }
}
