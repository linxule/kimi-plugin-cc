import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
export async function resolveMcpWorkspace(env, requested) {
    const defaultCandidate = env.KIMI_PLUGIN_CC_MCP_WORKSPACE;
    const candidate = requested ?? defaultCandidate;
    if (!candidate) {
        throw new RuntimeError("MCP_WORKSPACE_REQUIRED", "This MCP server has no default workspace. Supply the absolute workspace directory explicitly; Codex calls normally require it.", "mcp.workspace");
    }
    const cwd = await canonicalDirectory(candidate, "workspace");
    if (defaultCandidate) {
        const defaultCwd = await canonicalDirectory(defaultCandidate, "host workspace");
        const relative = path.relative(defaultCwd, cwd);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new RuntimeError("MCP_WORKSPACE_OUTSIDE_DEFAULT", `workspace must be the host workspace or one of its descendants, not ${cwd} (host: ${defaultCwd}).`, "mcp.workspace");
        }
    }
    return { cwd, repo: await resolveRepoIdentity(cwd) };
}
async function canonicalDirectory(candidate, label) {
    if (!path.isAbsolute(candidate)) {
        throw new RuntimeError("MCP_WORKSPACE_NOT_ABSOLUTE", `${label} must be an absolute existing directory.`, "mcp.workspace");
    }
    try {
        const cwd = await realpath(candidate);
        if (!(await stat(cwd)).isDirectory())
            throw new Error("not a directory");
        return cwd;
    }
    catch (error) {
        throw new RuntimeError("MCP_WORKSPACE_INVALID", `${label} is not an accessible existing directory: ${candidate}`, "mcp.workspace", error instanceof Error ? { cause: error } : undefined);
    }
}
