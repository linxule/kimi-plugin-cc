#!/usr/bin/env -S node --import tsx
// Mock kimi that starts a long-running descendant in a separate process group.
// This matches kimi-code's Bash tool subprocess shape more closely than
// shell job-control helpers that happen to die via SIGHUP.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const writerPath = process.env["KIMI_MOCK_GRANDCHILD_WRITE_FILE"];
const grandchild = spawn(
  writerPath === undefined ? "sleep" : process.execPath,
  writerPath === undefined
    ? ["60"]
    : [fileURLToPath(new URL("./term-ignoring-writer.mjs", import.meta.url))],
  {
    detached: true,
    stdio: "ignore",
    env:
      writerPath === undefined
        ? process.env
        : {
            ...process.env,
            KIMI_MOCK_GRANDCHILD_WRITE_FILE: writerPath,
            KIMI_MOCK_GRANDCHILD_READY_FILE:
              process.env["KIMI_MOCK_GRANDCHILD_READY_FILE"],
          },
  },
);

const pidLine = `GRANDCHILD_PID=${grandchild.pid ?? ""}\n`;
process.stdout.write(pidLine);
if (process.env["KIMI_MOCK_GRANDCHILD_PID_FILE"] !== undefined) {
  writeFileSync(process.env["KIMI_MOCK_GRANDCHILD_PID_FILE"], pidLine, "utf8");
}
process.stderr.write("To resume this session: kimi -r 30000000-0000-0000-0000-000000000000\n");

setTimeout(() => undefined, 0x7fffffff);
