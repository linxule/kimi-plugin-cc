#!/usr/bin/env -S node --import tsx
// Mock kimi that starts a long-running descendant in a separate process group.
// This matches kimi-code's Bash tool subprocess shape more closely than
// shell job-control helpers that happen to die via SIGHUP.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchild = spawn("sleep", ["60"], {
  detached: true,
  stdio: "ignore",
});

const pidLine = `GRANDCHILD_PID=${grandchild.pid ?? ""}\n`;
process.stdout.write(pidLine);
if (process.env["KIMI_MOCK_GRANDCHILD_PID_FILE"] !== undefined) {
  writeFileSync(process.env["KIMI_MOCK_GRANDCHILD_PID_FILE"], pidLine, "utf8");
}
process.stderr.write("To resume this session: kimi -r 30000000-0000-0000-0000-000000000000\n");

setTimeout(() => undefined, 0x7fffffff);
