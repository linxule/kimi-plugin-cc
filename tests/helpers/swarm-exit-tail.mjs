import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing fixture setting ${name}`);
  return value;
};
const ready = required("SWARM_TEST_LEAF_READY");
const writes = required("SWARM_TEST_WRITES");
const signals = required("SWARM_TEST_SIGNALS");

if (process.argv[2] === "leaf") {
  process.on("SIGTERM", () => appendFileSync(signals, `${Date.now()}\n`));
  appendFileSync(writes, "started\n");
  writeFileSync(ready, JSON.stringify({ pid: process.pid }));
  setInterval(() => appendFileSync(writes, "tick\n"), 10);
  // A failed test cannot leave this writer running indefinitely.
  setTimeout(() => process.exit(0), 15_000);
} else {
  const version = required("SWARM_TEST_VERSION");
  const shellExited = required("SWARM_TEST_SHELL_EXITED");
  const shellReady = required("SWARM_TEST_SHELL_READY");
  const rootRelease = required("SWARM_TEST_ROOT_RELEASE");
  const rootExited = required("SWARM_TEST_ROOT_EXITED");
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version })}\n`);
  const shell = spawn("/bin/sh", ["-c", [
    '"$SWARM_TEST_NODE" "$SWARM_TEST_FIXTURE" leaf &',
    "remaining=300",
    'while [ ! -f "$SWARM_TEST_SHELL_RELEASE" ] && [ "$remaining" -gt 0 ]; do sleep 0.02; remaining=$((remaining - 1)); done',
    "exit 0",
  ].join("\n")], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      SWARM_TEST_NODE: process.execPath,
      SWARM_TEST_FIXTURE: fileURLToPath(import.meta.url),
    },
  });
  writeFileSync(shellReady, JSON.stringify({ pid: shell.pid }));
  shell.on("error", (error) => { throw error; });
  shell.once("exit", () => {
    writeFileSync(shellExited, JSON.stringify({ pid: shell.pid }));
    const poll = setInterval(() => {
      if (!existsSync(rootRelease)) return;
      clearInterval(poll);
      writeFileSync(rootExited, JSON.stringify({ pid: process.pid, time: Date.now() }));
      process.stdout.write(`${JSON.stringify({ role: "assistant", content: "root completed" })}\n`, () => {
        process.exit(Number(process.env.SWARM_TEST_EXIT_CODE ?? "0"));
      });
    }, 10);
  });
  setTimeout(() => process.exit(90), 12_000).unref();
}
