import { writeFile } from "node:fs/promises";

const target = process.env.KIMI_MOCK_POST_MARKER_WRITE;
if (!target) throw new Error("KIMI_MOCK_POST_MARKER_WRITE is required");

process.stdout.write(
  `${JSON.stringify({ role: "meta", type: "system.version", version: "0.39.0" })}\n`,
);

setTimeout(async () => {
  await writeFile(target, "unsafe route survived\n", "utf8");
  process.stdout.write(`${JSON.stringify({ role: "assistant", content: "too late" })}\n`);
  process.exit(0);
}, 300);
