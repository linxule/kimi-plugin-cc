// bun test preload (bunfig.toml [test].preload): runs before every test file.
//
// Scrub host-plugin environment that a Claude Code / Codex session can export
// into the shell the suite runs in. `CLAUDE_PLUGIN_DATA` in particular may
// point at a REAL plugin data dir — even another plugin's — and any test that
// spreads `process.env` without overriding it would then write its config
// fixture (`reviewGateEnabled: true`) and mock job rows into the operator's
// live store. CI never sets these, so scrubbing makes local runs behave like
// CI. Tests that need a plugin root/data dir set their own explicitly.
for (const name of [
  "KIMI_PLUGIN_CC_DATA",
  "KIMI_PLUGIN_CC_SHELL_LAUNCH",
  "CLAUDE_PLUGIN_DATA",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "KIMI_PLUGIN_CC_WORKSPACE_CWD",
  "KIMI_PLUGIN_CC_CMD",
  "KIMI_PLUGIN_CC_OPERATION",
  "KIMI_PLUGIN_CC_WORKSPACE_ROOT",
  "KIMI_PLUGIN_CC_SWARM_POLICY",
  "KIMI_PLUGIN_CC_SWARM_WAVE_SIZE",
]) {
  delete process.env[name];
}
