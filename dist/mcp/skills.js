import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const SKILL_URI = "skill://kimi/SKILL.md";
export const SKILL_AGENT_URI = "skill://kimi/agents/openai.yaml";
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SKILL_PATH = path.join(PACKAGE_ROOT, "skills", "kimi", "SKILL.md");
const SKILL_AGENT_PATH = path.join(PACKAGE_ROOT, "skills", "kimi", "agents", "openai.yaml");
function parseFrontmatter(markdown) {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) {
        return { name: "kimi", description: "Delegate research, reviews, and bounded tasks to Kimi Code." };
    }
    const block = match[1];
    let name = "kimi";
    let description = "";
    const lines = block.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
        if (nameMatch) {
            name = stripQuotes(nameMatch[1]);
            continue;
        }
        const descMatch = line.match(/^description:\s*(.*)$/);
        if (descMatch) {
            const value = descMatch[1].trim();
            if (value === ">" || value === "|" || value === ">-" || value === "|-") {
                const folded = [];
                while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1])) {
                    i += 1;
                    folded.push(lines[i].trim());
                }
                description = folded.join(" ");
            }
            else {
                description = stripQuotes(value);
            }
        }
    }
    return {
        name,
        description: description || "Delegate research, reviews, and bounded tasks to Kimi Code.",
    };
}
function stripQuotes(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function sha256Digest(data) {
    return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
async function loadSkillBundle() {
    const [skillBytes, agentBytes] = await Promise.all([
        readFile(SKILL_PATH),
        readFile(SKILL_AGENT_PATH),
    ]);
    const skillText = skillBytes.toString("utf8");
    const agentText = agentBytes.toString("utf8");
    const { name, description } = parseFrontmatter(skillText);
    const manifest = {
        uri: SKILL_URI,
        frontmatter: { name, description },
        resources: [
            { uri: SKILL_URI, digest: sha256Digest(skillBytes), size: skillBytes.byteLength },
            { uri: SKILL_AGENT_URI, digest: sha256Digest(agentBytes), size: agentBytes.byteLength },
        ],
    };
    return { skillText, skillBytes, agentText, agentBytes, name, description, manifest };
}
export async function listMcpSkills() {
    const bundle = await loadSkillBundle();
    return { skills: [bundle.manifest] };
}
export async function getMcpSkill(uri) {
    if (uri !== SKILL_URI)
        return null;
    const bundle = await loadSkillBundle();
    return { skill: bundle.manifest };
}
export async function listMcpResources() {
    const bundle = await loadSkillBundle();
    return {
        resources: [
            {
                uri: SKILL_URI,
                name: bundle.name,
                title: "Kimi Collaboration Skill",
                description: bundle.description,
                mimeType: "text/markdown",
            },
            {
                uri: SKILL_AGENT_URI,
                name: `${bundle.name}/agents/openai.yaml`,
                title: "Kimi Agent Interface Metadata",
                description: "Agent UI metadata for the kimi skill.",
                mimeType: "application/yaml",
            },
        ],
    };
}
export async function readMcpResource(uri) {
    if (uri !== SKILL_URI && uri !== SKILL_AGENT_URI)
        return null;
    const bundle = await loadSkillBundle();
    if (uri === SKILL_URI) {
        return {
            contents: [
                {
                    uri: SKILL_URI,
                    mimeType: "text/markdown",
                    text: bundle.skillText,
                },
            ],
        };
    }
    return {
        contents: [
            {
                uri: SKILL_AGENT_URI,
                mimeType: "application/yaml",
                text: bundle.agentText,
            },
        ],
    };
}
