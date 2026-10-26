import { readFile } from 'node:fs/promises';
const size = (await readFile(new URL('../AGENTS.md', import.meta.url))).byteLength;
const limit = 32 * 1024;
if (size >= limit) {
  console.error(`AGENTS.md is ${size} bytes; keep the contract sheet below ${limit} bytes. Move mechanics to docs/invariants.md.`);
  process.exitCode = 1;
} else {
  console.log(`AGENTS.md: ${size}/${limit} bytes (${limit - size} bytes headroom).`);
}
