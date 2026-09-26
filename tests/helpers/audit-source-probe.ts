import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { selectPinnedDeclarations, transpileProbe } from "../../scripts/audit-source.js";

  const dir = mkdtempSync(path.join(tmpdir(), "audit-source-"));
  const file = path.join(dir, "source.ts");
  const source = `
    import "./must-not-load";
    throw new Error("Unselected top-level code must never execute");
    export const initial: number = 4;
    export class Counter {
      constructor(public value: number) {}
      next(): number { return ++this.value; }
    }
    export function calculate(): number { return new Counter(initial).next(); }
  `;
  const hash = createHash("sha256").update(source).digest("hex");
  try {
    writeFileSync(file, source);
    const code = await selectPinnedDeclarations(file, hash, ["initial", "Counter", "calculate"]);
    const sandbox: { result?: number } = {};
    runInNewContext(transpileProbe(code + "\nglobalThis.result = calculate();"), sandbox, { timeout: 1_000 });
    assert.equal(sandbox.result, 5);
    await assert.rejects(selectPinnedDeclarations(file, hash, ["absent"]), /Missing declarations: absent/);
    writeFileSync(file, source + "\n// changed after review");
    await assert.rejects(selectPinnedDeclarations(file, hash, ["calculate"]), /Unreviewed source/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
