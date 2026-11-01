import { randomUUID } from "node:crypto";
import { RuntimeError } from "./errors.js";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function allocateJobId(context) {
    const fixed = context.mcpJobId;
    if (fixed === undefined)
        return randomUUID();
    if (!UUID_PATTERN.test(fixed)) {
        throw new RuntimeError("MCP_INVALID_JOB_ID", "The supervised job ID must be a valid UUID.", "mcp.child");
    }
    return fixed;
}
