import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("audit extraction executes only selected declarations and rejects changed source", () => {
  // Exercise the same Bun subprocess environment as the command-line audits.
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../helpers/audit-source-probe.ts", import.meta.url))], {
    encoding: "utf8", timeout: 15_000,
  });
  expect(output).toBe("");
}, 20_000);
