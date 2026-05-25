#!/usr/bin/env -S node --import tsx
// Mock kimi that starts a long-running descendant in the same process group.
// Direct-child SIGTERM leaves the descendant alive; process-group SIGTERM kills it.

import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setTimeout(() => undefined, 0x7fffffff);"],
  { stdio: "ignore" },
);
grandchild.unref();

process.stdout.write(`${JSON.stringify({ role: "assistant", content: "spawned" })}\n`);
process.stderr.write(`KIMI_MOCK_GRANDCHILD_PID=${grandchild.pid ?? ""}\n`);
process.stderr.write("To resume this session: kimi -r 30000000-0000-0000-0000-000000000000\n");

process.on("SIGTERM", () => {
  process.exit(0);
});

setTimeout(() => undefined, 0x7fffffff);
