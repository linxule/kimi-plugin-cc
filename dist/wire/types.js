// Wire protocol version advertised to kimi-cli on the `initialize` handshake. Bumped to
// "1.10" alongside the StepRetry event kimi-cli 1.42.0 added. Centralized so every
// command-side initialize call agrees on a single value.
export const KIMI_WIRE_PROTOCOL_VERSION = "1.10";
