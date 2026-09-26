// Offline source extraction for hash-pinned audit probes. Never load upstream modules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Transpiler } from "bun";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isClassDeclaration, isFunctionDeclaration, isVariableStatement } from "typescript/unstable/ast";

export async function selectPinnedDeclarations(file: string, hash: string, names: string[]): Promise<string> {
  const source = readFileSync(file, "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), hash, `Unreviewed source: ${file}`);
  // Isolate parsing from upstream config, imports, and the host filesystem.
  const configPath = "/audit/tsconfig.json";
  const sourcePath = "/audit/source.ts";
  const files = {
    [configPath]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, types: [] },
      files: ["source.ts"],
    }),
    [sourcePath]: source,
  };
  const virtualFs = createVirtualFileSystem(files);
  const api = new API({ cwd: "/audit", fs: {
    ...virtualFs,
    readFile: file => files[file as keyof typeof files] ?? null,
    getAccessibleEntries: dir => virtualFs.getAccessibleEntries!(dir) ?? { files: [], directories: [] },
  } });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    assert.ok(project, "Missing audit parser project");
    const ast = await project.program.getSourceFile(sourcePath);
    assert.ok(ast, `Unable to parse source: ${file}`);
    assert.equal((await project.program.getSyntacticDiagnostics(sourcePath)).length, 0, `Invalid source: ${file}`);
    const wanted = new Set(names);
    const selected: string[] = [];
    for (const node of ast.statements) {
      const name = isFunctionDeclaration(node) || isClassDeclaration(node) ? node.name?.text
        : isVariableStatement(node) && node.declarationList.declarations.length === 1
          ? node.declarationList.declarations[0]?.name.getText(ast) : undefined;
      if (name && wanted.delete(name)) selected.push(node.getText(ast).replace(/^export\s+/, ""));
    }
    assert.equal(wanted.size, 0, `Missing declarations: ${[...wanted].join(", ")}`);
    return selected.join("\n");
  } finally {
    await api.close();
  }
}

export function transpileProbe(code: string): string {
  return new Transpiler({ loader: "ts", target: "bun" }).transformSync(code);
}
