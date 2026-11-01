import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
export async function writeInvocationLogHeader(logPath, metadata) {
    const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        direction: "meta",
        message: metadata,
    })}\n`;
    await mkdir(path.dirname(logPath), { recursive: true });
    try {
        await appendFile(logPath, line, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            // Directory vanished between mkdir and appendFile — recreate and retry once.
            await mkdir(path.dirname(logPath), { recursive: true });
            await appendFile(logPath, line, "utf8");
            return;
        }
        throw error;
    }
}
