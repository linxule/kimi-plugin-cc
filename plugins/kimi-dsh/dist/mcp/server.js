import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { createMcpMessageHandler } from "./protocol.js";
import { serveMcpStdio } from "./stdio.js";
export async function runMcpServer(context) {
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    await serveMcpStdio(process.stdin, process.stdout, createMcpMessageHandler(context.env));
}
