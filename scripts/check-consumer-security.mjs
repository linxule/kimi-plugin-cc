import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditHighSeverity } from './consumer-audit.mjs';

// Audit the installed consumer graph: this package's overrides and Bun lock
// do not constrain npm's resolution when this package is a dependency.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'kimi-consumer-security-'));
try {
  const conflicts = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/ [0-9]+(?:\.[^/]*)?$/.test(entry.name)) conflicts.push(path.relative(repo, file));
      else if (entry.isDirectory()) scan(file);
    }
  };
  for (const dir of ['dist', 'plugins/kimi-codex', 'plugins/kimi-dsh']) scan(path.join(repo, dir));
  if (conflicts.length > 0) throw new Error(`sync-conflict copies in package surfaces: ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? ` (and ${conflicts.length - 8} more)` : ''}`);
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const pack = spawnSync('bun', ['pm', 'pack', '--ignore-scripts', '--destination', scratch, '--quiet'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  if (pack.status !== 0) throw new Error(`package creation failed: ${pack.stderr}`);
  writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'kimi-consumer-audit', version: '1.0.0', private: true }));
  const archive = path.join(scratch, `${pkg.name}-${pkg.version}.tgz`);
  const install = spawnSync('npm', ['install', '--ignore-scripts', archive], { cwd: scratch, encoding: 'utf8', timeout: 180_000 });
  if (install.status !== 0) throw new Error(`isolated consumer install failed: ${install.stderr}`);
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=info', '--json'], { cwd: scratch, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const issues = auditHighSeverity(audit);
  for (const [name, issue] of issues) console.error(`${name}: ${issue.severity}, affected ${issue.range}`);
  if (issues.length > 0) throw new Error('installed consumer graph has high or critical vulnerabilities');
  console.log(`Verified isolated npm consumer security for ${pkg.name}@${pkg.version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
