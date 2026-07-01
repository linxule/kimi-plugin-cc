// Single source of truth for the plugin version that the runtime reports
// in setup output and managed-block markers. Keep this in sync with
// package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json,
// and AGENTS.md on every release. A future improvement would read this from
// package.json at build time, but that adds a build-step dependency we
// don't want yet.
export const KIMI_PLUGIN_CC_VERSION = "1.6.3";
