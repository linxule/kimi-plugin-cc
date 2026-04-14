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
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      direction: "meta",
      message: metadata,
    })}\n`,
    "utf8",
  );
}
