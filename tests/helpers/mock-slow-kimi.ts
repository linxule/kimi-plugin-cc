#!/usr/bin/env -S node --import tsx
// Mock kimi binary that ignores argv and blocks for longer than any
// reasonable probe timeout. Used to test `probeKimiVersion`'s timeout
// path without depending on `sleep` (which rejects `--version` on macOS
// and exits immediately).

setTimeout(() => {
  process.exit(0);
}, 10_000);
