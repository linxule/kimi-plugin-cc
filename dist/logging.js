import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
export async function writeInvocationLogHeader(logPath, metadata) {
    const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        direction: "meta",
        message: metadata,
    })}\n`;
    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
        await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
    }
    catch (error) {
        if (error.code === "ENOENT") {
            // Directory vanished between mkdir and appendFile — recreate and retry once.
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
        }
        else {
            throw error;
        }
    }
    if (process.platform !== "win32") {
        await chmod(logPath, 0o600);
    }
}
