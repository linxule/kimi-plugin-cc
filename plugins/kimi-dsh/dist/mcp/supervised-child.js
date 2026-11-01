import { RuntimeError } from "../errors.js";
import { allocateJobId } from "../job-id.js";
import { runModelCommand } from "../model-command.js";
export async function runMcpChild(argv, context) {
    const [jobId, ...command] = argv;
    if (!jobId || command.length === 0) {
        throw new RuntimeError("MCP_INVALID_CHILD", "mcp-child expects a job UUID followed by one model operation.", "mcp.child");
    }
    const mcpJobId = allocateJobId({ ...context, mcpJobId: jobId });
    const result = await runModelCommand(command, { ...context, mcpJobId });
    if (result === undefined) {
        throw new RuntimeError("MCP_INVALID_CHILD", "mcp-child accepts only the public model operations.", "mcp.child");
    }
    return result;
}
