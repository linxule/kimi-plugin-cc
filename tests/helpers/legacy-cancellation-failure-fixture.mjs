import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.env.LEGACY_CANCEL_TEST_ROOT;
if (!directory) throw new Error("Missing isolated cancellation fixture root");
const tail = process.argv[2] === "tail";
const name = tail ? "tail" : "root";
process.on("SIGTERM", () => appendFileSync(path.join(directory, `${name}-terms.json`), `${Date.now()}\n`));
appendFileSync(path.join(directory, `${name}-writes.json`), "started\n");
setInterval(() => appendFileSync(path.join(directory, `${name}-writes.json`), "tick\n"), 10);
// A broken test must not leave a fixture running indefinitely. Successful
// cases settle well before this deadline, proving TERM required escalation.
setTimeout(() => process.exit(90), 15_000);

if (tail) {
  writeFileSync(path.join(directory, "tail-ready.json"), JSON.stringify({ pid: process.pid }));
} else {
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version: "2.5.3" })}\n`);
  process.stdout.write(`${JSON.stringify({ role: "assistant", content: "partial output must not become a successful cancellation result" })}\n`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "tail"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  child.once("error", (error) => { throw error; });
}
