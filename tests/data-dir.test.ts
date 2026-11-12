// Where the local store lives: .data/ locally, /tmp on Vercel (read-only deployment file system),
// or an explicit override.
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dataDir } from "@/lib/data-dir";

describe("dataDir", () => {
  test("local development: .data in the project", () => {
    expect(dataDir({})).toBe(path.join(process.cwd(), ".data"));
  });
  test("on Vercel: /tmp/employai", () => {
    expect(dataDir({ VERCEL: "1" })).toBe(path.join("/tmp", "employai"));
  });
  test("EMPLOYAI_DATA_DIR wins over both", () => {
    expect(dataDir({ VERCEL: "1", EMPLOYAI_DATA_DIR: "/srv/employai" })).toBe("/srv/employai");
  });
});
