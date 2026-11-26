const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export async function serveMcpStdio(input, output, handle) {
    let buffer = Buffer.alloc(0);
    let writeTail = Promise.resolve();
    let writeError;
    const pending = new Set();
    const transportAbort = new AbortController();
    const abortTransport = () => {
        if (!transportAbort.signal.aborted)
            transportAbort.abort();
    };
    output.on("error", (error) => {
        writeError ??= error;
        abortTransport();
    });
    output.on("close", abortTransport);
    const write = (message) => {
        if (writeError)
            return Promise.reject(writeError);
        const frame = `${JSON.stringify(message)}\n`;
        writeTail = writeTail.then(() => new Promise((resolve, reject) => {
            try {
                if (output.write(frame))
                    resolve();
                else
                    output.once("drain", resolve);
            }
            catch (error) {
                reject(error);
            }
        }));
        return writeTail;
    };
    const track = (promise) => {
        const tracked = promise.catch((error) => { writeError ??= error; }).finally(() => pending.delete(tracked));
        pending.add(tracked);
    };
    try {
        for await (const chunk of input) {
            buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            for (;;) {
                const newline = buffer.indexOf(0x0a);
                if (newline < 0)
                    break;
                const line = buffer.subarray(0, newline);
                buffer = buffer.subarray(newline + 1);
                if (line.length > MAX_MESSAGE_BYTES)
                    throw new Error("MCP frame exceeds 8 MiB");
                const text = line.toString("utf8");
                if (text.trim().length === 0)
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    track(write({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } }));
                    continue;
                }
                track((async () => {
                    try {
                        const response = await handle(parsed, transportAbort.signal);
                        if (response !== undefined)
                            await write(response);
                    }
                    catch (error) {
                        await write({
                            jsonrpc: "2.0",
                            id: null,
                            error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
                        });
                    }
                })());
            }
            if (buffer.length > MAX_MESSAGE_BYTES)
                throw new Error("MCP frame exceeds 8 MiB");
        }
    }
    catch (error) {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: error instanceof Error ? error.message : String(error) } });
    }
    finally {
        // Stdin reached EOF or errored: abort active sync-wait pollers immediately
        // without cancelling any durable background Kimi jobs.
        abortTransport();
        output.off("close", abortTransport);
        await Promise.all(pending);
        await writeTail;
        if (writeError)
            throw writeError;
    }
}
