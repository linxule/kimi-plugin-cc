// Single source of truth for the plugin version that the runtime sends on the Wire handshake.
// Keep this in sync with package.json, .claude-plugin/plugin.json, and
// .claude-plugin/marketplace.json on every release. A future improvement would read this from
// package.json at build time, but that adds a build-step dependency we don't want yet.
export const KIMI_PLUGIN_CC_VERSION = "0.3.0";
