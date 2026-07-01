import { KIMI_PLUGIN_CC_VERSION } from "../runtime/version.js";

export const PLUGIN_NAME = "kimi";
export const MARKETPLACE_NAME = "kimi-marketplace";
// Single source of truth: the Codex manifest/marketplace version derives from the
// runtime version, so a release bump in runtime/version.ts propagates here without
// a second edit. The codex-surfaces test asserts PLUGIN_VERSION === package.json.
export const PLUGIN_VERSION = KIMI_PLUGIN_CC_VERSION;

// The Codex plugin is a SELF-CONTAINED subfolder so its root has no overlap with the
// Claude Code plugin root (the repo root). Claude Code auto-discovers a top-level
// skills/ dir by convention; keeping the Codex skills out of the repo root is what
// stops them leaking into the Claude Code surface. Codex copies this root to its
// install cache, so the subfolder also bundles the runtime it needs (see
// generate-surfaces.ts). One constant so the location is one-line-changeable.
export const CODEX_PLUGIN_SUBDIR = "plugins/kimi-codex";

export interface ClaudeSurfaceHash {
  path: string;
  sha256: string;
}

export interface CodexSkillSpec {
  name: string;
  title: string;
  description: string;
  displayName: string;
  shortDescription: string;
  defaultPrompt: string;
  command: string;
  argumentSummary: string;
  implicit: boolean;
  guidance: readonly string[];
}

export const CLAUDE_SURFACE_HASHES: readonly ClaudeSurfaceHash[] = [
  { path: ".claude-plugin/plugin.json", sha256: "799310c5611b11c4a14bf230b65939365c0f388bd1702013d31bb262711ccb93" },
  { path: ".claude-plugin/marketplace.json", sha256: "d037884cb870c9a490589ca95f31701d3c9bd0a5389d61942dd6e75e72d4a35b" },
  { path: "commands/README.md", sha256: "f996a084f8c7762c2405c3990443cff49d96003416da8fead8fd875a0f50fd23" },
  { path: "commands/ask.md", sha256: "5ffcd405b1f905f400c00520d210afc6dbf35cae3a0b07c6189866fa639bf778" },
  { path: "commands/cancel.md", sha256: "f6fc6e474242901e2e4836956f2b67c6335ff0042a7a6e60c8baf9585cec0035" },
  { path: "commands/challenge.md", sha256: "7131e086e84cbfcdfb6580b6b156480b21aec9e0ae5e2ebeb4e35c8c3ed76ef0" },
  { path: "commands/pursue.md", sha256: "9402c4780d5543de9c464276b206daccf31aab601a2c6800d0c1151ecb080de7" },
  { path: "commands/replay.md", sha256: "84e46faa17b032f43dccb37190e461d1da3f807226f3814a9e5cd302afcf12e3" },
  { path: "commands/rescue.md", sha256: "7708b9d2a48a25e260d1b711472d32c5a2b772b1e7bbdbd6279f55af75abf130" },
  { path: "commands/result.md", sha256: "d5ae361ea6c95f139e4bf1d2f23cb69e14c23c9e0e2b6e8084274e8245016db5" },
  { path: "commands/review.md", sha256: "2a5103029d91bd1f204979e8a52a9726ecfb171bcdc0b273be155ec7ced7c243" },
  { path: "commands/setup.md", sha256: "e9c0fc8d70c9e7d3106bcf5c751fccfe6ffb5cdc6f5011e6604e866475079fc3" },
  { path: "commands/status.md", sha256: "0171276cd08b9fe62893f62523c164f35b1a4df98cb7b04f14f62fc33fbc8cbc" },
  { path: "commands/swarm.md", sha256: "e4728c31c5d7ae355759bdb497ce340c994d05a9f1a65b4fa246895ee9bcfac5" },
  { path: "agents/kimi-ask.md", sha256: "e5acf18a261c44d95ccf8c78a112e30d8bb2edcdd3a784f741f2c30f6918d732" },
  { path: "agents/kimi-challenge.md", sha256: "afe252ee9bb67a2faa36df0f048ee91dbfbee7688b3fede4a427fd9033f8c062" },
  { path: "agents/kimi-pursue.md", sha256: "aa9646824ed8cebd306a21a0a0ba3b73508a4aa4c3fbe7424a2ac9af33c84c17" },
  { path: "agents/kimi-rescue.md", sha256: "0844c0e40cd3301c9325b6ed406a2ca4c8de2d151bddbc1e30bb1e37a4fdd2e3" },
  { path: "agents/kimi-review.md", sha256: "a7db8c7d821d64cda88aac44df04f5b3cd6f3026f19098dae037097239daddb7" },
  { path: "agents/kimi-swarm-write.md", sha256: "d789393d499ab44aed9f62c69782cda1a61637b85e9e195fdfc9eeff9f22a530" },
  { path: "agents/kimi-swarm.md", sha256: "415f628e68aae2a23ade0628eb231d0aff9b9677c1d746fe3eaab876f8f116d6" },
];

export const CODEX_PLUGIN_MANIFEST = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Codex plugin that delegates review, challenge, ask, rescue, pursue, and swarm workflows to the local kimi-code CLI through the kimi-plugin-cc companion runtime.",
  author: {
    name: "linxule",
  },
  homepage: "https://github.com/linxule/kimi-plugin-cc",
  repository: "https://github.com/linxule/kimi-plugin-cc",
  license: "Apache-2.0",
  keywords: ["kimi", "kimi-code", "review", "code-review", "delegation", "multi-model"],
  skills: "./skills/",
  interface: {
    displayName: "Kimi",
    shortDescription: "Delegate repo work to local kimi-code",
    longDescription:
      "Shell-only Codex packaging for kimi-plugin-cc. It exposes Codex skills that call the existing companion runtime and local kimi-code subprocess, while preserving the Claude Code plugin surface.",
    developerName: "linxule",
    category: "Developer Tools",
    capabilities: ["Code Review", "Local Shell", "Write"],
    websiteURL: "https://github.com/linxule/kimi-plugin-cc",
    defaultPrompt: [
      "Use $kimi-review to review my current diff.",
      "Use $kimi-ask to explain this repository flow.",
      "Use $kimi-rescue to delegate a bounded fix.",
    ],
    brandColor: "#0F766E",
  },
} as const;

export const CODEX_MARKETPLACE = {
  name: MARKETPLACE_NAME,
  interface: {
    displayName: "Kimi Marketplace",
  },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: {
        source: "local",
        path: "./plugins/kimi-codex",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    },
  ],
} as const;

export const CODEX_SKILLS: readonly CodexSkillSpec[] = [
  {
    name: "kimi-ask",
    title: "Kimi Ask",
    displayName: "Kimi Ask",
    shortDescription: "Ask Kimi a read-only repo question",
    defaultPrompt: "Use $kimi-ask to explain the current repository flow.",
    implicit: true,
    command: "ask",
    argumentSummary: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>",
    description:
      "Ask Kimi a read-only free-form question about the current repository. Use for prose explanations, flow tracing, module comparisons, or conceptual reasoning where Codex should delegate the answer to local kimi-code rather than perform implementation.",
    guidance: [
      "Preserve the user's question and supplied flags exactly; use `-r` only for explicit resume intent unless `--fresh` is requested.",
      "Choose `--background` for broad or long-running questions and return the job id that the companion prints.",
      "Return companion stdout verbatim; do not summarize or re-voice Kimi's prose.",
    ],
  },
  {
    name: "kimi-review",
    title: "Kimi Review",
    displayName: "Kimi Review",
    shortDescription: "Run Kimi read-only code review",
    defaultPrompt: "Use $kimi-review to review the current working tree.",
    implicit: true,
    command: "review",
    argumentSummary: "[--base <ref>] [-m <model>] [extra prose]",
    description:
      "Run an independent read-only Kimi review over the current working tree or a branch diff. Use when the user wants a second reviewer for defects, regressions, or implementation risks, not edits.",
    guidance: [
      "Forward `--base <ref>`, `-m`/`--model <name>`, and any trailing focus text only.",
      "Do not invent file/path flags; review's payload is the git diff plus optional focus text.",
      "Return companion stdout verbatim and leave any fixes to a separate user request.",
    ],
  },
  {
    name: "kimi-challenge",
    title: "Kimi Challenge",
    displayName: "Kimi Challenge",
    shortDescription: "Challenge a design or approach",
    defaultPrompt: "Use $kimi-challenge to stress-test this approach.",
    implicit: true,
    command: "task challenge",
    argumentSummary: "[--base <ref>] [-m <model>] [extra prose]",
    description:
      "Run a read-only adversarial Kimi challenge review that questions assumptions, design choices, and tradeoffs. Use when the user wants pushback on whether the approach is right, not a defect-only review.",
    guidance: [
      "Preserve the user's adversarial framing as trailing focus text.",
      "Do not pass background/wait flags; the runtime rejects them for challenge.",
      "Return companion stdout verbatim without softening the challenge framing.",
    ],
  },
  {
    name: "kimi-rescue",
    title: "Kimi Rescue",
    displayName: "Kimi Rescue",
    shortDescription: "Delegate a bounded Kimi fix",
    defaultPrompt: "Use $kimi-rescue to delegate this bounded implementation task.",
    implicit: false,
    command: "task rescue",
    argumentSummary: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>",
    description:
      "Delegate a bounded write-capable investigation or implementation task to Kimi through the companion runtime. Use only when explicitly invoked or when the user clearly asks to hand off a substantial fix to Kimi.",
    guidance: [
      "Preserve the task text and constraints with minimal reframing.",
      "Use background mode for long-running investigations and report the job id for status/result/cancel.",
      "Do not inspect or edit the repository yourself as part of the skill; the companion result is the source of truth.",
    ],
  },
  {
    name: "kimi-pursue",
    title: "Kimi Pursue",
    displayName: "Kimi Pursue",
    shortDescription: "Run autonomous Kimi goal mode",
    defaultPrompt: "Use $kimi-pursue to let Kimi pursue this objective with a budget.",
    implicit: false,
    command: "task pursue",
    argumentSummary: "[--budget <30m|1h>] [--turns <N>] [-m <model>] <objective>",
    description:
      "Run Kimi's autonomous goal mode for an explicitly requested hands-off multi-turn objective. This is write-capable and budget-bounded; use only when the user explicitly asks Kimi to pursue an objective autonomously.",
    guidance: [
      "Require explicit hands-off autonomy intent; single bounded fixes belong to `kimi-rescue`.",
      "Always keep a finite `--budget`; never background this command.",
      "Surface terminal goal statuses exactly as the companion reports them.",
    ],
  },
  {
    name: "kimi-swarm",
    title: "Kimi Swarm",
    displayName: "Kimi Swarm",
    shortDescription: "Fan out Kimi read-only review",
    defaultPrompt: "Use $kimi-swarm to fan out a read-only review across these targets.",
    implicit: false,
    command: "task swarm",
    argumentSummary: "[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>",
    description:
      "Run a read-only parallel Kimi review fan-out across many independent targets. Use only for explicit broad fan-out requests where one subagent per target is the point.",
    guidance: [
      "Require many independent review targets plus explicit fan-out intent.",
      "Pass finite budget and concurrency bounds; default to foreground unless the user explicitly asks to detach.",
      "Return the consolidated companion report verbatim.",
    ],
  },
  {
    name: "kimi-swarm-write",
    title: "Kimi Swarm Write",
    displayName: "Kimi Swarm Write",
    shortDescription: "Fan out patch-only Kimi edits",
    defaultPrompt: "Use $kimi-swarm-write to fan out these disjoint edits into a patch.",
    implicit: false,
    command: "task swarm --write",
    argumentSummary: "[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>",
    description:
      "Run a write-capable Kimi swarm that edits many disjoint targets in a throwaway worktree and returns a reviewable patch. Use only for explicit parallel edit fan-out requests; the plugin never applies or commits the patch.",
    guidance: [
      "Require both many disjoint write targets and explicit parallel fan-out intent.",
      "Keep `--max-concurrency` conservative, normally 1, unless the user explicitly asks to widen it.",
      "Return the patch path and companion output verbatim; do not apply the patch unless the user separately asks.",
    ],
  },
  {
    name: "kimi-setup",
    title: "Kimi Setup",
    displayName: "Kimi Setup",
    shortDescription: "Install or check Kimi hooks",
    defaultPrompt: "Use $kimi-setup to check the local Kimi companion setup.",
    implicit: false,
    command: "setup",
    argumentSummary: "[--check | --uninstall | --enable-review-gate | --disable-review-gate]",
    description:
      "Verify local Kimi companion readiness and manage the kimi-code PreToolUse hook plus optional review gate state. Use when explicitly requested to install, check, enable, disable, or uninstall the integration.",
    guidance: [
      "Run setup from the user's workspace so the companion records the intended workspace cwd.",
      "Use `--check` for read-only verification and `--uninstall` only when explicitly requested.",
      "Report setup stdout verbatim because it contains hook and probe status.",
    ],
  },
  {
    name: "kimi-status",
    title: "Kimi Status",
    displayName: "Kimi Status",
    shortDescription: "Show Kimi job status",
    defaultPrompt: "Use $kimi-status to show the latest Kimi job status.",
    implicit: false,
    command: "status",
    argumentSummary: "[<job-id>] [--type <review|challenge|rescue|review_gate|ask>]",
    description:
      "Show the latest or selected plugin-managed Kimi job for the current repository. Use when the user explicitly asks for Kimi job status or progress.",
    guidance: [
      "Preserve any job id or `--type` filter.",
      "Return companion stdout verbatim; it is the persisted job state.",
    ],
  },
  {
    name: "kimi-result",
    title: "Kimi Result",
    displayName: "Kimi Result",
    shortDescription: "Return a Kimi job result",
    defaultPrompt: "Use $kimi-result to return the latest Kimi job result.",
    implicit: false,
    command: "result",
    argumentSummary: "[<job-id>] [--type <review|challenge|rescue|review_gate|ask>] [--json]",
    description:
      "Return the stored rendered result for the latest or selected terminal Kimi job. Use when the user explicitly asks for a Kimi job result or artifact body.",
    guidance: [
      "Preserve any job id, `--type`, and `--json` flag.",
      "Return companion stdout verbatim; `--json` is the structured automation surface.",
    ],
  },
  {
    name: "kimi-cancel",
    title: "Kimi Cancel",
    displayName: "Kimi Cancel",
    shortDescription: "Cancel an active Kimi job",
    defaultPrompt: "Use $kimi-cancel to cancel this active Kimi job.",
    implicit: false,
    command: "cancel",
    argumentSummary: "[<job-id>]",
    description:
      "Cancel an active plugin-managed Kimi job for the current repository. Use only when the user explicitly asks to cancel a Kimi run.",
    guidance: [
      "Pass the requested job id when supplied; otherwise let the companion choose the latest active job for this repository.",
      "Return companion stdout verbatim so the user sees the cancellation state.",
    ],
  },
  {
    name: "kimi-replay",
    title: "Kimi Replay",
    displayName: "Kimi Replay",
    shortDescription: "Replay a Kimi event log",
    defaultPrompt: "Use $kimi-replay to re-render this Kimi job event log.",
    implicit: false,
    command: "replay",
    argumentSummary: "<job-id>",
    description:
      "Re-render a stored event log for a completed plugin-managed Kimi job. Use only when the user explicitly asks to replay a Kimi job.",
    guidance: [
      "Require a job id and pass it unchanged.",
      "Return companion stdout verbatim because replay output is the diagnostic artifact.",
    ],
  },
];
