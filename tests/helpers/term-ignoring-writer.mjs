import { appendFileSync, writeFileSync } from "node:fs";

const writePath = process.env.KIMI_MOCK_GRANDCHILD_WRITE_FILE;
const readyPath = process.env.KIMI_MOCK_GRANDCHILD_READY_FILE;
const termSignalPath = process.env.KIMI_MOCK_TERM_SIGNAL_FILE;
if (writePath === undefined || readyPath === undefined) {
  process.exit(2);
}

process.on("SIGTERM", () => {
  // The client must reach its SIGKILL escalation even after our parent exits.
  if (termSignalPath !== undefined) {
    appendFileSync(termSignalPath, `${Date.now()}\n`, "utf8");
  }
});

appendFileSync(writePath, "started\n", "utf8");
writeFileSync(readyPath, `READY_PID=${process.pid}\n`, "utf8");
setInterval(() => appendFileSync(writePath, "tick\n", "utf8"), 5);
