import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { RuntimeCommandType } from "./types.js";

export interface InvocationLogMetadata {
  commandType: RuntimeCommandType;
  kimiSessionId: string | null;
  cwd: string;
}

export async function writeInvocationLogHeader(
  logPath: string,
  metadata: InvocationLogMetadata,
): Promise<void> {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    direction: "meta",
    message: metadata,
  })}\n`;

  await mkdir(path.dirname(logPath), { recursive: true });
  try {
    await appendFile(logPath, line, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Directory vanished between mkdir and appendFile — recreate and retry once.
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, line, "utf8");
      return;
    }
    throw error;
  }
}
