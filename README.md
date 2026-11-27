# Kimi for Claude Code, Codex, Antigravity, DeepSeek Harness, and Magpie

[![Latest release](https://img.shields.io/github/v/release/linxule/kimi-plugin-cc)](https://github.com/linxule/kimi-plugin-cc/releases/latest) [![CI](https://img.shields.io/github/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/linxule/kimi-plugin-cc/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Use Kimi from Claude Code, Codex, Antigravity, DeepSeek Harness (DSH), or Magpie. You can ask questions, review changes, challenge designs, fix files, or run parallel tasks. One package gives every host the same 4 MCP tools, one `kimi` skill, one shared data directory, and one PreToolUse safety hook.

[![Kimi Ambassador, academia](./assets/kimi-ambassador-academia.webp)](https://www.kimi.ai/lp/kimi-ambassador)

I am a [Kimi Ambassador](https://www.kimi.ai/lp/kimi-ambassador) (academia). Kimi (Moonshot AI) supports this project through that role.

[Latest release](https://github.com/linxule/kimi-plugin-cc/releases/latest) · [npm package](https://www.npmjs.com/package/kimi-plugin-cc) · [Migration guide](./docs/migration.md) · [Report an issue](https://github.com/linxule/kimi-plugin-cc/issues) · [Apache-2.0 license](./LICENSE)

![Claude Code reviewing this repository with Kimi and verifying each finding in the same session](./assets/claude-code-kimi-review.jpg)

Claude Code reviews this repository with Kimi and checks each finding against the working tree.

Choose a language below. Each guide opens on this page.

选择语言，展开阅读 · Choisissez votre langue · 言語を選んで開いてください

<details open>
<summary>English: get started</summary>

## Use Kimi in your coding tasks

Send questions, code reviews, design challenges, workspace fixes, multi-step goals, and parallel swarms to your local Kimi Code CLI. You can call Kimi from Claude Code, Codex, Antigravity, DeepSeek Harness (DSH), or Magpie.

The plugin runs Kimi on your machine with your own Kimi subscription or API key. It never changes your host login. Your Kimi provider receives only the prompts and code that each task reads.

Read-only tasks cannot edit files or run shell commands. Write tasks edit files only inside your workspace or a temporary Git worktree, and they never change Git history.

## Before you install

You need:

- macOS or Linux
- Claude Code, Codex, Antigravity, DSH `>=0.2.1-rc.5 <0.3.0`, or Magpie (or any stdio MCP client)
- Node.js 22.5 or newer (24.9 or newer for DSH)
- Kimi Code CLI `2.8.0` or newer (this plugin certifies `2.8.0` for all 7 operations and refuses older versions)

This plugin does not support model runs on Windows. Contributors can run the [Windows diagnostics checks](./docs/ci.md#windows-spawn-controls).

Install Kimi Code with the [Kimi Code getting started guide](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started), or let `kimi_setup` install a certified `2.8.0` binary for you. You do not need Bun or a build step.

Run `kimi` in your terminal, then use `/login` for a Kimi subscription or `/provider` for an API key. Enter credentials only in Kimi, never in an assistant chat. If you set `KIMI_CODE_HOME`, use the same directory for Kimi and this plugin.

## Install in Claude Code

Run these commands in Claude Code inside your project:

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Claude Code loads the `kimi` MCP server from `.mcp.json` and the `skills/kimi/SKILL.md` skill automatically. Ask Claude to install and check the safety hook:

```text
Run kimi_setup with action "install", then action "check".
```

Check that the `Probe:` line shows `ok`. Then try a read-only question:

```text
Use Kimi to explain how this project's main entry point works.
```

## Install in Codex

Run these commands in your terminal:

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Open a new Codex task in your project and send this prompt:

```text
Use $kimi to run kimi_setup (install, then check), then explain how this project's main entry point works.
```

## Install in Antigravity

Link or copy the repository root into the Antigravity plugins directory. The root includes `plugin.json`, `mcp_config.json`, `assets/logo.svg`, and `skills/kimi/SKILL.md`:

```sh
ln -sfn /path/to/kimi-plugin-cc ~/.gemini/config/plugins/kimi
```

Restart Antigravity or reload its plugins. Then ask Antigravity to run `kimi_setup` with `action: "install"` and `action: "check"`.

## Install in DeepSeek Harness

Update your DSH host and profile dependencies to `zod >=4.6.6` and `undici >=8.12.2` before installing the plugin. Follow the [patched DSH host and profiles guide](./docs/safety.md#patched-dsh-host-and-profiles) first.

Install the root package from npm or a local checkout. DSH loads `cordis.patch.yml` from the root with `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-skill-filesystem`:

```sh
dsh plugin --profile web add kimi-plugin-cc
```

To install from a local checkout, run `dsh plugin --profile web add .` instead. For DSH Discover, turn on custom plugin indexes and add `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`. Restart DSH, then run `kimi_setup` with `install` and `check`.

## Install in Magpie and other MCP clients

Register `scripts/companion.sh mcp` as a local stdio MCP server for agents such as Copilot, Cursor, and Grok:

```sh
magpie library mcp add kimi /path/to/kimi-plugin-cc/scripts/companion.sh mcp agents=copilot,cursor,grok --local
```

Do not add `claude`, `codex`, `antigravity`, or `dsh` in Magpie when they load the Kimi plugin directly, so the server name does not collide.

Run `/path/to/kimi-plugin-cc/scripts/companion.sh setup` and `setup --check` once in your terminal, or call `kimi_setup` from the agent.

## Install from npm

You can also install [`kimi-plugin-cc` from npm](https://www.npmjs.com/package/kimi-plugin-cc) into a dedicated package directory. Keep that directory separate from `~/.local/share/kimi-plugin-cc`, which stores shared runtime data:

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc-pkg kimi-plugin-cc@3.1.2
claude --plugin-dir ~/.local/share/kimi-plugin-cc-pkg/node_modules/kimi-plugin-cc
```

Do not load an npm copy alongside an enabled marketplace copy in the same host. Maintainers can read the [npm publishing guide](./docs/ci.md#npm-oidc-publishing).

## Use Kimi with MCP

Every host shares the same 4 MCP tools and full `SEP-2640` skill discovery (`skills/list`, `skills/get`, `resources/list`, and `resources/read` for `skill://kimi/SKILL.md` and `skill://kimi/agents/openai.yaml`):

| Tool | Modes or actions | Can it write files |
| --- | --- | --- |
| `kimi_read` | `mode`: `ask` (default), `review`, `challenge`, `swarm` | No |
| `kimi_write` | `mode`: `rescue` (default), `pursue`, `swarm_patch` | Workspace files only (`swarm_patch` returns an unapplied worktree patch), never Git |
| `kimi_job` | `action`: `list`, `status`, `result`, `wait`, `cancel`, `replay`, `recover_swarm` | No (stops jobs or saves recovery patches) |
| `kimi_setup` | `action`: `check` (default), `models`, `install`, `install_kimi`, `repair_sessions` | Updates `~/.kimi-code/config.toml` hook block, plugin-owned CLI, or session previews |

Standard `tools/call` requests on `kimi_read` and `kimi_write` wait up to 50 seconds by default (`wait: true`) and return the answer directly. You can raise `wait_timeout_ms` up to `86400000` milliseconds (24 hours). If the client disconnects or cancels the wait, polling stops while the Kimi job keeps running.

Set `wait: false` to get `{ job_id }` right away when you start parallel tasks. You can then check, wait on, or stop each job with `kimi_job`. Clients that support MCP `2026-07-28` tasks (`io.modelcontextprotocol/tasks`) receive native task handles for `tasks/get` and `tasks/cancel`.

Pass an absolute `workspace` path when your host does not set a default project directory. Always pass any `Warnings:` block back to the user.

## Use Kimi from the terminal

Run the 5 primary CLI subcommands through `scripts/companion.sh`:

| Command | What it does |
| --- | --- |
| `scripts/companion.sh read [--mode ask\|review\|challenge\|swarm] [options] [--] [prompt]` | Run a read-only question, diff review (`--base <ref>`), design challenge, or parallel read-only swarm |
| `scripts/companion.sh write [--mode rescue\|pursue\|swarm-patch] [options] [--] <prompt>` | Run a workspace fix, multi-step goal, or temporary worktree patch swarm |
| `scripts/companion.sh job <list\|status\|result\|wait\|cancel\|replay\|recover-swarm> [job-id]` | List, check, read, wait on, stop, replay, or recover jobs |
| `scripts/companion.sh setup [--check\|--uninstall\|--models\|--install-kimi\|--repair-sessions]` | Install or check the hook, list models, install certified Kimi `2.8.0`, or repair session previews |
| `scripts/companion.sh mcp` | Start the stdio MCP server |

Place `--mode` and other flags before `--` or the prompt text. Older subcommands such as `ask`, `review`, `task rescue`, `status`, `result`, and `cancel` still work as aliases.

## Point a task at an earlier session

Pass 1 to 8 earlier job IDs or Kimi session IDs with `referenced_sessions` in MCP or `--reference-session <id>` in the CLI. You can use session references on `ask`, `review`, `challenge`, `rescue`, `swarm`, and `swarm_patch`, but not on `pursue`:

```sh
scripts/companion.sh read --reference-session <job-id> -- Continue the migration from where that session stopped.
```

Kimi receives the path to each session's main log and reads only what it needs. When you set `read_roots` or `network`, the plugin adds each referenced session's `agents/main` directory to the allowed read roots. Combine session references with `network` only when those session logs may leave your machine.

## Limit what a task can read and reach

By default, read-only tasks can read any file your user account can read and cannot access the web. You can restrict `kimi_read` (`ask`, `review`, `challenge`, and `swarm`) and `companion.sh read` with 2 options:

- `read_roots` or `--read-root <abs-dir>` (repeatable) limits `Read`, `Grep`, `Glob`, and `ReadMediaFile` to the workspace and listed directories
- `network: true` or `--network` allows `WebSearch` and `FetchURL` to public hosts and limits the 4 read tools to the workspace and listed read roots

Write tasks reject both options. Read and network limits apply to one run only and never carry over to resumed turns.

## Keep Kimi working when Kimi updates

Plugin 3.1.0 uses a rolling compatibility window starting at Kimi Code `2.8.0`:

- exact `2.8.0` runs all 7 operations
- unlisted plain `2.y.z` releases above `2.8.0` run `ask`, `review`, and `challenge` with a warning and `--environment local`
- unlisted plain `2.y.z` releases above `2.8.0` refuse write tasks, swarm tasks, and `--network` with `KIMI_CAPABILITY_NOT_CERTIFIED`
- releases below `2.8.0` refuse every operation

To keep all 7 operations working on a certified binary across every host, run `kimi_setup({ action: "install_kimi" })` or `scripts/companion.sh setup --install-kimi`. This is the only command that downloads files from the network. Jobs select `KIMI_PLUGIN_CC_KIMI_BIN` first, then `<data-dir>/kimi-bin/current` inside the shared data directory, and then `kimi` on `PATH`.

## Share one data directory and safety hook

All 5 hosts share one data directory (`<data-dir>`) and one bundled PreToolUse safety hook at `<data-dir>/hook/approval-hook.js`. The default data directory is `~/.local/share/kimi-plugin-cc` (or `$XDG_DATA_HOME/kimi-plugin-cc`) on macOS and Linux, and `%LOCALAPPDATA%\kimi-plugin-cc` on Windows. You can override the base directory with `KIMI_PLUGIN_CC_DATA` so data lives in `$KIMI_PLUGIN_CC_DATA/kimi-plugin-cc`.

Running `setup` once publishes the bundled hook and writes one `# === BEGIN kimi-plugin-cc-managed (v3.1.2) ===` block in `~/.kimi-code/config.toml`. It also replaces any older `:<host-id>` blocks from version 3.0. Hosts that use the same Node binary need only one setup run. If your hosts use different Node paths, point them to the same binary with `KIMI_PLUGIN_CC_NODE_BIN`.

## Manage sessions, models, and jobs

Sessions appear in Kimi Code Desktop and `kimi web` with your raw prompt as the preview. Run `kimi_setup({ action: "repair_sessions" })` or `scripts/companion.sh setup --repair-sessions [--apply] [--all]` to fix missing previews. Read [session visibility and titles](./docs/session-visibility.md) for details.

List your configured model aliases offline with `kimi_setup({ action: "models" })` or `scripts/companion.sh setup --models [--json]`. Pass `model` in MCP or `-m` in the CLI to pick a model for one run, or run `/model` inside `kimi` to change your default. Read [model selection](./docs/models.md) for details.

Track or stop jobs with `kimi_job` (`list`, `status`, `result`, `wait`, `cancel`, `replay`, and `recover_swarm`) or `scripts/companion.sh job`. Always stop jobs with `kimi_job` or `job cancel` instead of interrupting the host so `swarm_patch` can save its patch. Read [swarm recovery](./docs/swarm-recovery.md) for interrupted runs.

Run `scripts/companion.sh setup --uninstall` to remove the managed safety hook. If you are upgrading from version 3.0, follow [upgrading from 3.0 to 3.1](./docs/migration.md#upgrading-from-30-to-31).

## Understand the safety limits

One PreToolUse safety hook checks every Kimi tool call:

- read-only tasks deny file edits and shell commands
- write tasks edit files only inside your workspace and never change Git state
- `swarm_patch` edits files inside a temporary Git worktree off `HEAD` and returns an unapplied patch

The plugin does not:

- limit file reads unless you set `read_roots` or `network`
- check DNS resolution or HTTP redirects after `FetchURL` validates the written URL
- sandbox repository test runners started by write tasks
- apply patches or create Git commits

Run write tasks only in repositories you trust. For refusal codes and release history, see [safety and refusal codes](./docs/safety.md#native-v2-refusal-codes) and the [changelog](./CHANGELOG.md).

## Report issues and contribute

Report bugs or suggest changes in [GitHub issues](https://github.com/linxule/kimi-plugin-cc/issues). Contributors can read [runtime invariants](./docs/invariants.md) and [continuous integration details](./docs/ci.md).

</details>

<details>
<summary>简体中文：开始使用</summary>

## 在编码任务中使用 Kimi

你可以将代码提问、变更审查、设计质疑、工作区修复、多步目标和并行任务发送给本地 Kimi Code CLI。支持从 Claude Code、Codex、Antigravity、DeepSeek Harness（DSH）或 Magpie 直接调用 Kimi。

插件使用你自己的 Kimi 订阅或 API 密钥在本地运行 Kimi，绝不会改动宿主应用的登录状态。你的 Kimi 服务商只会收到当前任务读取的提示词和代码。

只读任务不能编辑文件或运行 shell 命令。写入任务只能在你的工作区或临时 Git 工作树内编辑文件，且绝不改动 Git 历史。

## 安装前准备

你需要准备以下环境：

- macOS 或 Linux
- Claude Code、Codex、Antigravity、DSH `>=0.2.1-rc.5 <0.3.0` 或 Magpie（或任何 stdio MCP 客户端）
- Node.js 22.5 或更高版本（DSH 需要 24.9 或更高版本）
- Kimi Code CLI `2.8.0` 或更高版本（本插件对 `2.8.0` 认证了全部 7 项操作，并拒绝更早版本）

Windows 不支持运行模型任务。贡献者可以运行 [Windows 诊断检查](./docs/ci.md#windows-spawn-controls)。

你可以按照 [Kimi Code 入门指南](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) 安装 Kimi Code，也可以让 `kimi_setup` 自动安装已认证的 `2.8.0` 二进制文件。无需安装 Bun，也无需执行构建步骤。

先在终端运行 `kimi`，使用 `/login` 登录 Kimi 订阅，或使用 `/provider` 配置 API 密钥。请只在 Kimi 终端中输入凭据，切勿在助手对话中粘贴密钥。如果设置了 `KIMI_CODE_HOME`，请确保 Kimi 和本插件使用同一个目录。

## 在 Claude Code 中安装

在项目目录中打开 Claude Code 并运行：

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Claude Code 会自动加载 `.mcp.json` 中的 `kimi` MCP 服务器和 `skills/kimi/SKILL.md` 技能。让 Claude 安装并检查安全钩子：

```text
Run kimi_setup with action "install", then action "check".
```

确认输出中的 `Probe:` 行显示 `ok`，然后尝试一个只读提问：

```text
Use Kimi to explain how this project's main entry point works.
```

## 在 Codex 中安装

在终端中运行以下命令：

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

在项目中打开一个新的 Codex 任务并发送：

```text
Use $kimi to run kimi_setup (install, then check), then explain how this project's main entry point works.
```

## 在 Antigravity 中安装

将仓库根目录软链接或复制到 Antigravity 的插件目录。根目录包含 `plugin.json`、`mcp_config.json`、`assets/logo.svg` 和 `skills/kimi/SKILL.md`：

```sh
ln -sfn /path/to/kimi-plugin-cc ~/.gemini/config/plugins/kimi
```

重启 Antigravity 或重新加载插件，然后让 Antigravity 调用 `kimi_setup`（先运行 `action: "install"`，再运行 `action: "check"`）。

## 在 DeepSeek Harness 中安装

安装插件前，请先将 DSH 宿主与配置文件依赖更新到 `zod >=4.6.6` 和 `undici >=8.12.2`。请先按照 [DSH 宿主与配置补丁指南](./docs/safety.md#patched-dsh-host-and-profiles) 完成更新。

从 npm 或本地检出安装根包。DSH 会通过 `@deepseek-ai/dsh-mcp-client` 和 `@deepseek-ai/dsh-skill-filesystem` 直接加载根目录下的 `cordis.patch.yml`：

```sh
dsh plugin --profile web add kimi-plugin-cc
```

若从本地检出安装，请改用 `dsh plugin --profile web add .`。如果使用 DSH Discover，请开启自定义插件索引并添加 `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`。重启 DSH 后，调用 `kimi_setup` 执行 `install` 和 `check`。

## 在 Magpie 和其他 MCP 客户端中安装

将 `scripts/companion.sh mcp` 注册为本地 stdio MCP 服务器，供 Copilot、Cursor 和 Grok 等代理调用：

```sh
magpie library mcp add kimi /path/to/kimi-plugin-cc/scripts/companion.sh mcp agents=copilot,cursor,grok --local
```

如果 `claude`、`codex`、`antigravity` 或 `dsh` 已经直接加载了 Kimi 插件，请不要在 Magpie 中添加它们，以免服务器名称冲突。

随后在终端中运行一次 `/path/to/kimi-plugin-cc/scripts/companion.sh setup` 和 `setup --check`，或者直接让代理调用 `kimi_setup`。

## 从 npm 安装

你也可以从 npm 安装 [`kimi-plugin-cc` 包](https://www.npmjs.com/package/kimi-plugin-cc) 到单独的包目录中。请将该目录与存放共享运行时数据的 `~/.local/share/kimi-plugin-cc` 分开：

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc-pkg kimi-plugin-cc@3.1.2
claude --plugin-dir ~/.local/share/kimi-plugin-cc-pkg/node_modules/kimi-plugin-cc
```

请勿在同一个宿主中同时加载 npm 副本和已启用的插件市场副本。维护者请参阅 [npm 发布指南](./docs/ci.md#npm-oidc-publishing)。

## 通过 MCP 使用 Kimi

所有宿主共享相同的 4 个 MCP 工具，并支持完整的 `SEP-2640` 技能发现（通过 `skills/list`、`skills/get`、`resources/list` 和 `resources/read` 读取 `skill://kimi/SKILL.md` 与 `skill://kimi/agents/openai.yaml`）：

| 工具 | 模式或操作 | 是否写入文件 |
| --- | --- | --- |
| `kimi_read` | `mode`: `ask`（默认）、`review`、`challenge`、`swarm` | 否 |
| `kimi_write` | `mode`: `rescue`（默认）、`pursue`、`swarm_patch` | 仅限工作区文件（`swarm_patch` 返回未应用的工作树补丁），绝不改动 Git |
| `kimi_job` | `action`: `list`、`status`、`result`、`wait`、`cancel`、`replay`、`recover_swarm` | 否（用于停止任务或保存恢复补丁） |
| `kimi_setup` | `action`: `check`（默认）、`models`、`install`、`install_kimi`、`repair_sessions` | 更新 `~/.kimi-code/config.toml` 钩子块、插件专用 CLI 或会话预览 |

对 `kimi_read` 和 `kimi_write` 的标准 `tools/call` 请求默认最多等待 50 秒（`wait: true`），并直接返回结果文本。你可以将 `wait_timeout_ms` 调高至 `86400000` 毫秒（24 小时）。如果客户端断开连接或取消等待，插件会停止轮询，而后台 Kimi 任务会继续运行。

在并行启动多个任务时，传入 `wait: false` 可以立即获得 `{ job_id }`。随后你可以用 `kimi_job` 查看、等待或停止每个任务。支持 MCP `2026-07-28` 任务协议（`io.modelcontextprotocol/tasks`）的客户端会直接收到可用于 `tasks/get` 和 `tasks/cancel` 的原生任务句柄。

当宿主没有设置默认项目目录时，请传入绝对路径 `workspace`。收到任何 `Warnings:` 警告块时，请原样转达给用户。

## 在终端中使用 Kimi

你可以通过 `scripts/companion.sh` 直接运行 5 个主 CLI 子命令：

| 命令 | 用途 |
| --- | --- |
| `scripts/companion.sh read [--mode ask\|review\|challenge\|swarm] [options] [--] [prompt]` | 运行只读提问、差异审查（`--base <ref>`）、设计质疑或并行只读任务 |
| `scripts/companion.sh write [--mode rescue\|pursue\|swarm-patch] [options] [--] <prompt>` | 运行工作区修复、多步目标或临时工作树补丁任务 |
| `scripts/companion.sh job <list\|status\|result\|wait\|cancel\|replay\|recover-swarm> [job-id]` | 列出、查看、读取、等待、停止、重放或恢复任务 |
| `scripts/companion.sh setup [--check\|--uninstall\|--models\|--install-kimi\|--repair-sessions]` | 安装或检查安全钩子、列出模型、安装认证版 Kimi `2.8.0` 或修复会话预览 |
| `scripts/companion.sh mcp` | 启动 stdio MCP 服务器 |

请将 `--mode` 和其他选项放在 `--` 或提示词之前。旧版子命令写法（如 `ask`、`review`、`task rescue`、`status`、`result` 和 `cancel`）仍作为兼容别名保留。

## 在任务中引用早期会话

在 MCP 中使用 `referenced_sessions` 或在 CLI 中使用 `--reference-session <id>`，可以传入 1 到 8 个早期任务 ID 或 Kimi 会话 ID。此功能适用于 `ask`、`review`、`challenge`、`rescue`、`swarm` 和 `swarm_patch`，但不适用于 `pursue`：

```sh
scripts/companion.sh read --reference-session <job-id> -- Continue the migration from where that session stopped.
```

Kimi 会收到每个会话主日志的路径，并按需读取内容。当你设置了 `read_roots` 或 `network` 时，插件会将每个被引用会话的 `agents/main` 目录加入允许读取的根目录列表。请仅在这些会话日志内容允许离开本机时，才将其与 `network` 一起使用。

## 限制任务的读取范围和网络访问

默认情况下，只读任务可以读取当前系统用户有权读取的任何文件，且不能访问互联网。你可以通过以下 2 个选项限制 `kimi_read`（`ask`、`review`、`challenge` 和 `swarm`）与 `companion.sh read`：

- `read_roots` 或 `--read-root <abs-dir>`（可重复）将 `Read`、`Grep`、`Glob` 和 `ReadMediaFile` 限制在工作区和列出的目录内
- `network: true` 或 `--network` 允许 `WebSearch` 和 `FetchURL` 访问公共主机，并将上述 4 个读取工具限制在工作区和列出的读取目录内

写入任务不接受这两个选项。读取范围和网络限制仅对单次运行生效，不会继承到后续恢复的会话轮次。

## 在 Kimi 更新时保持兼容

插件 3.1.0 采用从 Kimi Code `2.8.0` 起算的滚动兼容窗口：

- 精确版本 `2.8.0` 支持运行全部 7 项操作
- 高于 `2.8.0` 的未列入正式版 `2.y.z` 可以带警告并使用 `--environment local` 运行只读的 `ask`、`review` 和 `challenge`
- 高于 `2.8.0` 的未列入正式版 `2.y.z` 会以 `KIMI_CAPABILITY_NOT_CERTIFIED` 拒绝写入任务、并行 swarm 任务和 `--network`
- 低于 `2.8.0` 的版本会拒绝所有操作

若要在所有宿主之间共享同一个已认证的二进制文件并保持全部 7 项操作可用，请运行 `kimi_setup({ action: "install_kimi" })` 或 `scripts/companion.sh setup --install-kimi`。这是唯一会从网络下载文件的命令。任务会优先选择 `KIMI_PLUGIN_CC_KIMI_BIN`，其次是共享数据目录下的 `<data-dir>/kimi-bin/current`，最后是 `PATH` 中的 `kimi`。

## 共享单一数据目录和安全钩子

全部 5 个宿主共享同一个数据目录（`<data-dir>`）和位于 `<data-dir>/hook/approval-hook.js` 的单一打包 PreToolUse 安全钩子。默认数据目录在 macOS 和 Linux 上为 `~/.local/share/kimi-plugin-cc`（或 `$XDG_DATA_HOME/kimi-plugin-cc`），在 Windows 上为 `%LOCALAPPDATA%\kimi-plugin-cc`。你可以用 `KIMI_PLUGIN_CC_DATA` 覆盖父级基础目录，使数据存放在 `$KIMI_PLUGIN_CC_DATA/kimi-plugin-cc` 下。

运行一次 `setup` 即可发布打包好的安全钩子，并在 `~/.kimi-code/config.toml` 中写入单一的 `# === BEGIN kimi-plugin-cc-managed (v3.1.2) ===` 配置块，同时自动合并 3.0 版本遗留的 `:<host-id>` 配置块。共享同一个 Node 二进制文件的宿主只需运行一次 `setup`。如果不同宿主解析到不同的 Node 路径，请通过 `KIMI_PLUGIN_CC_NODE_BIN` 将它们指向同一个 Node 可执行文件。

## 管理会话、模型和任务

会话会显示在 Kimi Code Desktop 和 `kimi web` 中，并以你的原始请求作为预览文本。运行 `kimi_setup({ action: "repair_sessions" })` 或 `scripts/companion.sh setup --repair-sessions [--apply] [--all]` 可以修复缺失的预览。详见 [会话可见性与标题](./docs/session-visibility.md)。

使用 `kimi_setup({ action: "models" })` 或 `scripts/companion.sh setup --models [--json]` 可以在本地离线列出已配置的模型别名。在 MCP 中传入 `model` 或在 CLI 中传入 `-m` 可为单次运行指定模型，也可在 `kimi` 内部运行 `/model` 更改默认模型。详见 [模型选择指南](./docs/models.md)。

使用 `kimi_job`（`list`、`status`、`result`、`wait`、`cancel`、`replay` 和 `recover_swarm`）或 `scripts/companion.sh job` 跟踪或停止任务。请务必通过 `kimi_job` 或 `job cancel` 停止任务，而不要直接强行中断宿主，以便 `swarm_patch` 能够保存生成的补丁。关于中断任务的恢复，请参阅 [swarm 恢复指南](./docs/swarm-recovery.md)。

如需移除托管的安全钩子，请运行 `scripts/companion.sh setup --uninstall`。如果你正从 3.0 版本升级，请参阅 [从 3.0 升级到 3.1](./docs/migration.md#upgrading-from-30-to-31)。

## 了解安全边界

单一的 PreToolUse 安全钩子会检查每一次 Kimi 工具调用：

- 只读任务禁止修改文件和运行 shell 命令
- 写入任务只能在工作区内修改文件，且绝不改动 Git 状态
- `swarm_patch` 在基于 `HEAD` 的临时 Git 工作树内修改文件，并返回未应用的补丁

本插件不会执行以下操作：

- 除非设置了 `read_roots` 或 `network`，否则不限制文件读取范围
- 在 `FetchURL` 校验字面 URL 之后，不检查 DNS 解析结果或 HTTP 重定向目标
- 不对写入任务启动的仓库测试运行器进行操作系统级沙箱隔离
- 不自动应用补丁，也不创建 Git 提交

请仅在受信任的代码仓库中运行写入任务。关于拒绝码和版本历史，请参阅 [安全性与拒绝码](./docs/safety.md#native-v2-refusal-codes) 和 [更新日志](./CHANGELOG.md)。

## 报告问题与参与贡献

欢迎在 [GitHub issues](https://github.com/linxule/kimi-plugin-cc/issues) 中报告缺陷或提出改进建议。贡献者可以阅读 [运行时不变量](./docs/invariants.md) 和 [持续集成说明](./docs/ci.md)。

</details>

<details>
<summary>Français : bien démarrer</summary>

## Utiliser Kimi dans vos tâches de développement

Envoyez vos questions, revues de code, critiques de conception, correctifs ciblés, objectifs en plusieurs étapes et tâches parallèles à votre CLI locale Kimi Code. Vous pouvez appeler Kimi depuis Claude Code, Codex, Antigravity, DeepSeek Harness (DSH) ou Magpie.

Le plugin exécute Kimi sur votre machine avec votre propre abonnement Kimi ou votre clé API. Il ne modifie jamais la connexion de votre application hôte. Votre fournisseur Kimi reçoit uniquement les invites et le code lus par chaque tâche.

Les tâches en lecture seule ne peuvent ni modifier de fichiers ni lancer de commandes shell. Les tâches en écriture modifient des fichiers uniquement dans votre espace de travail ou dans un arbre de travail Git temporaire, sans jamais modifier l'historique Git.

## Avant d'installer

Vous avez besoin des éléments suivants :

- macOS ou Linux
- Claude Code, Codex, Antigravity, DSH `>=0.2.1-rc.5 <0.3.0` ou Magpie (ou tout client MCP stdio)
- Node.js 22.5 ou plus récent (24.9 ou plus récent pour DSH)
- Kimi Code CLI `2.8.0` ou plus récent (ce plugin certifie `2.8.0` pour les 7 opérations et refuse les versions plus anciennes)

Ce plugin ne prend pas en charge l'exécution des modèles sous Windows. Les contributeurs peuvent lancer les [vérifications de diagnostic sous Windows](./docs/ci.md#windows-spawn-controls).

Installez Kimi Code avec le [guide de démarrage Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started), ou laissez `kimi_setup` installer un binaire `2.8.0` certifié pour vous. Vous n'avez besoin ni de Bun ni d'une étape de compilation.

Lancez `kimi` dans votre terminal, puis utilisez `/login` pour un abonnement Kimi ou `/provider` pour une clé API. Saisissez vos identifiants uniquement dans Kimi, jamais dans la discussion avec un assistant. Si vous définissez `KIMI_CODE_HOME`, utilisez le même répertoire pour Kimi et pour ce plugin.

## Installer dans Claude Code

Exécutez ces commandes dans Claude Code depuis votre projet :

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Claude Code charge automatiquement le serveur MCP `kimi` depuis `.mcp.json` ainsi que la compétence `skills/kimi/SKILL.md`. Demandez à Claude d'installer et de vérifier le hook de sécurité :

```text
Run kimi_setup with action "install", then action "check".
```

Vérifiez que la ligne `Probe:` affiche `ok`. Essayez ensuite une question en lecture seule :

```text
Use Kimi to explain how this project's main entry point works.
```

## Installer dans Codex

Exécutez ces commandes dans votre terminal :

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Ouvrez une nouvelle tâche Codex dans votre projet et envoyez cette invite :

```text
Use $kimi to run kimi_setup (install, then check), then explain how this project's main entry point works.
```

## Installer dans Antigravity

Créez un lien symbolique ou copiez la racine du dépôt dans le répertoire des plugins d'Antigravity. La racine contient `plugin.json`, `mcp_config.json`, `assets/logo.svg` et `skills/kimi/SKILL.md` :

```sh
ln -sfn /path/to/kimi-plugin-cc ~/.gemini/config/plugins/kimi
```

Redémarrez Antigravity ou rechargez ses plugins. Demandez ensuite à Antigravity d'exécuter `kimi_setup` avec `action: "install"` puis `action: "check"`.

## Installer dans DeepSeek Harness

Mettez d'abord à jour les dépendances de votre hôte et de votre profil DSH vers `zod >=4.6.6` et `undici >=8.12.2`. Suivez le [guide des correctifs pour l'hôte et les profils DSH](./docs/safety.md#patched-dsh-host-and-profiles) avant d'installer le plugin.

Installez le paquet racine depuis npm ou depuis un clone local. DSH charge directement `cordis.patch.yml` à la racine grâce à `@deepseek-ai/dsh-mcp-client` et `@deepseek-ai/dsh-skill-filesystem` :

```sh
dsh plugin --profile web add kimi-plugin-cc
```

Pour installer le plugin depuis un clone local, exécutez `dsh plugin --profile web add .`. Pour DSH Discover, activez les index de plugins personnalisés et ajoutez `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`. Redémarrez DSH, puis exécutez `kimi_setup` avec `install` et `check`.

## Installer dans Magpie et d'autres clients MCP

Enregistrez `scripts/companion.sh mcp` comme serveur MCP stdio local pour des agents tels que Copilot, Cursor et Grok :

```sh
magpie library mcp add kimi /path/to/kimi-plugin-cc/scripts/companion.sh mcp agents=copilot,cursor,grok --local
```

N'ajoutez pas `claude`, `codex`, `antigravity` ou `dsh` dans Magpie lorsque ces hôtes chargent déjà le plugin Kimi directement, afin d'éviter tout conflit de nom de serveur.

Exécutez ensuite `/path/to/kimi-plugin-cc/scripts/companion.sh setup` et `setup --check` une fois dans votre terminal, ou appelez `kimi_setup` depuis l'agent.

## Installer depuis npm

Vous pouvez aussi installer [`kimi-plugin-cc` depuis npm](https://www.npmjs.com/package/kimi-plugin-cc) dans un répertoire de paquet dédié. Gardez ce répertoire séparé de `~/.local/share/kimi-plugin-cc`, qui stocke les données d'exécution partagées :

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc-pkg kimi-plugin-cc@3.1.2
claude --plugin-dir ~/.local/share/kimi-plugin-cc-pkg/node_modules/kimi-plugin-cc
```

Ne chargez pas une copie npm en même temps qu'une copie issue du marketplace dans le même hôte. Les mainteneurs peuvent consulter le [guide de publication npm](./docs/ci.md#npm-oidc-publishing).

## Utiliser Kimi avec MCP

Chaque hôte partage les mêmes 4 outils MCP et la découverte complète des compétences `SEP-2640` (`skills/list`, `skills/get`, `resources/list` et `resources/read` pour `skill://kimi/SKILL.md` et `skill://kimi/agents/openai.yaml`) :

| Outil | Modes ou actions | Écriture de fichiers |
| --- | --- | --- |
| `kimi_read` | `mode`: `ask` (par défaut), `review`, `challenge`, `swarm` | Non |
| `kimi_write` | `mode`: `rescue` (par défaut), `pursue`, `swarm_patch` | Fichiers de l'espace de travail uniquement (`swarm_patch` renvoie un patch non appliqué), jamais Git |
| `kimi_job` | `action`: `list`, `status`, `result`, `wait`, `cancel`, `replay`, `recover_swarm` | Non (arrête les tâches ou enregistre les patchs de récupération) |
| `kimi_setup` | `action`: `check` (par défaut), `models`, `install`, `install_kimi`, `repair_sessions` | Met à jour le bloc hook de `~/.kimi-code/config.toml`, la CLI dédiée ou les aperçus de session |

Les appels standards `tools/call` sur `kimi_read` et `kimi_write` attendent jusqu'à 50 secondes par défaut (`wait: true`) et renvoient directement la réponse. Vous pouvez augmenter `wait_timeout_ms` jusqu'à `86400000` millisecondes (24 heures). Si le client se déconnecte ou annule l'attente, l'attente s'arrête mais la tâche Kimi continue en arrière-plan.

Passez `wait: false` pour obtenir `{ job_id }` immédiatement lorsque vous lancez des tâches en parallèle. Vous pouvez ensuite vérifier, attendre ou arrêter chaque tâche avec `kimi_job`. Les clients prenant en charge les tâches MCP `2026-07-28` (`io.modelcontextprotocol/tasks`) reçoivent des identifiants natifs pour `tasks/get` et `tasks/cancel`.

Passez un chemin absolu `workspace` lorsque votre hôte ne définit pas de répertoire de projet par défaut. Transmettez toujours tout bloc `Warnings:` à l'utilisateur.

## Utiliser Kimi depuis le terminal

Exécutez les 5 sous-commandes CLI principales via `scripts/companion.sh` :

| Commande | Action |
| --- | --- |
| `scripts/companion.sh read [--mode ask\|review\|challenge\|swarm] [options] [--] [prompt]` | Lancer une question en lecture seule, une revue de diff (`--base <ref>`), une critique de conception ou un swarm parallèle en lecture seule |
| `scripts/companion.sh write [--mode rescue\|pursue\|swarm-patch] [options] [--] <prompt>` | Lancer un correctif dans l'espace de travail, un objectif en plusieurs étapes ou un swarm de patch dans un arbre de travail temporaire |
| `scripts/companion.sh job <list\|status\|result\|wait\|cancel\|replay\|recover-swarm> [job-id]` | Lister, vérifier, lire, attendre, arrêter, rejouer ou récupérer des tâches |
| `scripts/companion.sh setup [--check\|--uninstall\|--models\|--install-kimi\|--repair-sessions]` | Installer ou vérifier le hook, lister les modèles, installer Kimi `2.8.0` certifié ou réparer les aperçus de session |
| `scripts/companion.sh mcp` | Démarrer le serveur MCP stdio |

Placez `--mode` et les autres options avant `--` ou le texte de l'invite. Les anciennes sous-commandes comme `ask`, `review`, `task rescue`, `status`, `result` et `cancel` fonctionnent toujours comme alias.

## Pointer une tâche vers une session précédente

Passez 1 à 8 identifiants de tâches ou de sessions Kimi précédentes avec `referenced_sessions` en MCP ou `--reference-session <id>` en CLI. Vous pouvez utiliser des références de session avec `ask`, `review`, `challenge`, `rescue`, `swarm` et `swarm_patch`, mais pas avec `pursue` :

```sh
scripts/companion.sh read --reference-session <job-id> -- Continue the migration from where that session stopped.
```

Kimi reçoit le chemin du journal principal de chaque session et lit uniquement ce dont il a besoin. Lorsque vous activez `read_roots` ou `network`, le plugin ajoute le répertoire `agents/main` de chaque session référencée aux répertoires de lecture autorisés. Combinez des références de session avec `network` uniquement si le contenu de ces journaux peut quitter votre machine.

## Limiter les fichiers lus et l'accès réseau

Par défaut, les tâches en lecture seule peuvent lire tout fichier accessible à votre compte utilisateur et n'ont pas accès au web. Vous pouvez restreindre `kimi_read` (`ask`, `review`, `challenge` et `swarm`) ainsi que `companion.sh read` avec 2 options :

- `read_roots` ou `--read-root <abs-dir>` (répétable) limite `Read`, `Grep`, `Glob` et `ReadMediaFile` à l'espace de travail et aux répertoires indiqués
- `network: true` ou `--network` autorise `WebSearch` et `FetchURL` vers les hôtes publics et limite les 4 outils de lecture à l'espace de travail et aux répertoires indiqués

Les tâches en écriture refusent ces 2 options. Ces limites de lecture et de réseau s'appliquent à une seule exécution et ne sont jamais héritées lors d'une reprise.

## Garder Kimi fonctionnel lors des mises à jour

Le plugin 3.1.0 applique une fenêtre de compatibilité glissante à partir de Kimi Code `2.8.0` :

- la version exacte `2.8.0` exécute les 7 opérations
- les versions `2.y.z` standard supérieures à `2.8.0` exécutent `ask`, `review` et `challenge` en lecture seule avec un avertissement et `--environment local`
- les versions `2.y.z` standard supérieures à `2.8.0` refusent les tâches en écriture, les tâches swarm et `--network` avec le code `KIMI_CAPABILITY_NOT_CERTIFIED`
- les versions inférieures à `2.8.0` refusent toutes les opérations

Pour conserver les 7 opérations sur un binaire certifié partagé par tous les hôtes, exécutez `kimi_setup({ action: "install_kimi" })` ou `scripts/companion.sh setup --install-kimi`. C'est la seule commande qui télécharge des fichiers depuis le réseau. Les tâches choisissent d'abord `KIMI_PLUGIN_CC_KIMI_BIN`, puis `<data-dir>/kimi-bin/current` dans le répertoire de données partagé, et enfin `kimi` dans le `PATH`.

## Partager un répertoire de données et un hook de sécurité

Les 5 hôtes partagent un seul répertoire de données (`<data-dir>`) et un seul hook de sécurité PreToolUse empaqueté dans `<data-dir>/hook/approval-hook.js`. Le répertoire de données par défaut est `~/.local/share/kimi-plugin-cc` (ou `$XDG_DATA_HOME/kimi-plugin-cc`) sous macOS et Linux, et `%LOCALAPPDATA%\kimi-plugin-cc` sous Windows. Vous pouvez remplacer le répertoire parent avec `KIMI_PLUGIN_CC_DATA` pour stocker les données dans `$KIMI_PLUGIN_CC_DATA/kimi-plugin-cc`.

Exécuter `setup` une seule fois publie le hook empaqueté et écrit un bloc unique `# === BEGIN kimi-plugin-cc-managed (v3.1.2) ===` dans `~/.kimi-code/config.toml`. Cette commande remplace aussi automatiquement les anciens blocs `:<host-id>` de la version 3.0. Les hôtes qui partagent le même binaire Node n'ont besoin que d'une seule exécution de `setup`. Si vos hôtes utilisent des chemins Node différents, pointez-les vers le même binaire avec `KIMI_PLUGIN_CC_NODE_BIN`.

## Gérer les sessions, les modèles et les tâches

Les sessions apparaissent dans Kimi Code Desktop et `kimi web` avec votre invite brute comme aperçu. Exécutez `kimi_setup({ action: "repair_sessions" })` ou `scripts/companion.sh setup --repair-sessions [--apply] [--all]` pour réparer les aperçus manquants. Consultez [visibilité et titres des sessions](./docs/session-visibility.md) pour plus de détails.

Listez hors ligne vos alias de modèles configurés avec `kimi_setup({ action: "models" })` ou `scripts/companion.sh setup --models [--json]`. Passez `model` en MCP ou `-m` en CLI pour choisir un modèle sur une exécution, ou lancez `/model` dans `kimi` pour changer votre modèle par défaut. Consultez [sélection du modèle](./docs/models.md) pour plus de détails.

Suivez ou arrêtez vos tâches avec `kimi_job` (`list`, `status`, `result`, `wait`, `cancel`, `replay` et `recover_swarm`) ou `scripts/companion.sh job`. Arrêtez toujours une tâche avec `kimi_job` ou `job cancel` plutôt qu'en interrompant l'hôte, afin que `swarm_patch` puisse enregistrer son patch. Consultez [récupération de swarm](./docs/swarm-recovery.md) pour les exécutions interrompues.

Exécutez `scripts/companion.sh setup --uninstall` pour retirer le hook de sécurité géré. Si vous effectuez une mise à niveau depuis la version 3.0, suivez le guide de [mise à niveau de 3.0 vers 3.1](./docs/migration.md#upgrading-from-30-to-31).

## Comprendre les limites de sécurité

Un seul hook de sécurité PreToolUse vérifie chaque appel d'outil de Kimi :

- les tâches en lecture seule refusent les modifications de fichiers et les commandes shell
- les tâches en écriture modifient uniquement les fichiers de votre espace de travail et ne modifient jamais l'état Git
- `swarm_patch` modifie les fichiers dans un arbre de travail Git temporaire basé sur `HEAD` et renvoie un patch non appliqué

Le plugin ne fait pas ce qui suit :

- il ne limite pas la lecture des fichiers sauf si vous définissez `read_roots` ou `network`
- il ne vérifie pas la résolution DNS ni les redirections HTTP après la validation de l'URL par `FetchURL`
- il n'isole pas dans un bac à sable système les lanceurs de tests du dépôt exécutés par les tâches en écriture
- il n'applique pas de patchs et ne crée pas de commits Git

Exécutez des tâches en écriture uniquement dans des dépôts auxquels vous faites confiance. Pour connaître les codes de refus et l'historique des versions, consultez [la sécurité et les codes de refus](./docs/safety.md#native-v2-refusal-codes) et le [journal des modifications](./CHANGELOG.md).

## Signaler un problème et contribuer

Signalez les bogues ou proposez des modifications dans les [issues GitHub](https://github.com/linxule/kimi-plugin-cc/issues). Les contributeurs peuvent lire les [invariants d'exécution](./docs/invariants.md) et les [détails d'intégration continue](./docs/ci.md).

</details>

<details>
<summary>日本語：はじめに</summary>

## コーディングタスクで Kimi を使う

質問、コードレビュー、設計への批評、ワークスペース内の修正、複数ステップのゴール、並列スウォームをローカルの Kimi Code CLI に送信できます。Claude Code、Codex、Antigravity、DeepSeek Harness（DSH）、または Magpie から Kimi を呼び出せます。

プラグインはご自身の Kimi サブスクリプションまたは API キーを使ってローカルで Kimi を実行し、ホスト側のログイン状態を変更しません。Kimi のプロバイダーには、各タスクが読み取ったプロンプトとコードだけが送信されます。

読み取り専用タスクは、ファイルの編集もシェルコマンドの実行もできません。書き込みタスクは、ワークスペース内または一時的な Git ワークツリー内のファイルだけを編集し、Git の履歴は一切変更しません。

## インストール前の準備

次の環境が必要です：

- macOS または Linux
- Claude Code、Codex、Antigravity、DSH `>=0.2.1-rc.5 <0.3.0`、または Magpie（もしくは任意の stdio MCP クライアント）
- Node.js 22.5 以降（DSH は 24.9 以降）
- Kimi Code CLI `2.8.0` 以降（このプラグインは `2.8.0` で全 7 操作を認定しており、それより古いバージョンを拒否します）

Windows ではモデル実行をサポートしていません。コントリビューターは [Windows 診断チェック](./docs/ci.md#windows-spawn-controls) を実行できます。

[Kimi Code はじめにガイド](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) に従って Kimi Code をインストールするか、`kimi_setup` を使って認定済みの `2.8.0` バイナリをインストールしてください。Bun やビルド手順は不要です。

ターミナルで `kimi` を実行し、サブスクリプションなら `/login`、API キーなら `/provider` で認証してください。認証情報は必ず Kimi 内で入力し、アシスタントのチャットには入力しないでください。`KIMI_CODE_HOME` を設定する場合は、Kimi とこのプラグインで同じディレクトリを使ってください。

## Claude Code へのインストール

プロジェクト内の Claude Code で次のコマンドを実行します：

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Claude Code は `.mcp.json` から `kimi` MCP サーバーを、`skills/kimi/SKILL.md` からスキルを自動的に読み込みます。Claude に安全フックのインストールと確認を依頼してください：

```text
Run kimi_setup with action "install", then action "check".
```

`Probe:` の行に `ok` と表示されることを確認してから、読み取り専用の質問を試してください：

```text
Use Kimi to explain how this project's main entry point works.
```

## Codex へのインストール

ターミナルで次のコマンドを実行します：

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

プロジェクトで新しい Codex タスクを開き、次のプロンプトを送信します：

```text
Use $kimi to run kimi_setup (install, then check), then explain how this project's main entry point works.
```

## Antigravity へのインストール

リポジトリのルートディレクトリを Antigravity のプラグインディレクトリにシンボリックリンクまたはコピーします。ルートには `plugin.json`、`mcp_config.json`、`assets/logo.svg`、`skills/kimi/SKILL.md` が含まれています：

```sh
ln -sfn /path/to/kimi-plugin-cc ~/.gemini/config/plugins/kimi
```

Antigravity を再起動するかプラグインを再読み込みしてから、`kimi_setup` を `action: "install"` と `action: "check"` で実行するよう依頼してください。

## DeepSeek Harness へのインストール

プラグインをインストールする前に、DSH のホストとプロファイルの依存関係を `zod >=4.6.6` と `undici >=8.12.2` に更新してください。最初に [パッチ適用済み DSH ホストとプロファイルの手順](./docs/safety.md#patched-dsh-host-and-profiles) を実行してください。

npm またはローカルのチェックアウトからルートパッケージをインストールします。DSH は `@deepseek-ai/dsh-mcp-client` と `@deepseek-ai/dsh-skill-filesystem` を使ってルートの `cordis.patch.yml` を直接読み込みます：

```sh
dsh plugin --profile web add kimi-plugin-cc
```

ローカルのチェックアウトからインストールする場合は、`dsh plugin --profile web add .` を実行してください。DSH Discover を使う場合は、カスタムプラグインインデックスを有効にして `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json` を追加します。DSH を再起動してから、`kimi_setup` で `install` と `check` を実行してください。

## Magpie とその他の MCP クライアントへのインストール

Copilot、Cursor、Grok などのエージェント向けに、`scripts/companion.sh mcp` をローカル stdio MCP サーバーとして登録します：

```sh
magpie library mcp add kimi /path/to/kimi-plugin-cc/scripts/companion.sh mcp agents=copilot,cursor,grok --local
```

`claude`、`codex`、`antigravity`、`dsh` がすでに Kimi プラグインを直接読み込んでいる場合は、サーバー名の競合を防ぐため Magpie 側には追加しないでください。

その後、ターミナルで `/path/to/kimi-plugin-cc/scripts/companion.sh setup` と `setup --check` を 1 回実行するか、エージェントから `kimi_setup` を呼び出してください。

## npm からのインストール

専用のパッケージディレクトリに [npm から `kimi-plugin-cc`](https://www.npmjs.com/package/kimi-plugin-cc) をインストールすることもできます。共有ランタイムデータを保存する `~/.local/share/kimi-plugin-cc` とは別のディレクトリを指定してください：

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc-pkg kimi-plugin-cc@3.1.2
claude --plugin-dir ~/.local/share/kimi-plugin-cc-pkg/node_modules/kimi-plugin-cc
```

同じホスト内で、有効なマーケットプレイス版と npm 版を同時に読み込まないでください。メンテナーは [npm 公開手順](./docs/ci.md#npm-oidc-publishing) を参照してください。

## MCP で Kimi を使う

すべてのホストが同じ 4 つの MCP ツールと完全な `SEP-2640` スキル検出（`skill://kimi/SKILL.md` と `skill://kimi/agents/openai.yaml` に対する `skills/list`、`skills/get`、`resources/list`、`resources/read`）を共有します：

| ツール | モードまたはアクション | ファイル書き込み |
| --- | --- | --- |
| `kimi_read` | `mode`: `ask`（既定）、`review`、`challenge`、`swarm` | 不可 |
| `kimi_write` | `mode`: `rescue`（既定）、`pursue`、`swarm_patch` | ワークスペース内のファイルのみ（`swarm_patch` は未適用のワークツリーパッチを返す）、Git の変更は不可 |
| `kimi_job` | `action`: `list`、`status`、`result`、`wait`、`cancel`、`replay`、`recover_swarm` | 不可（ジョブの停止や復旧パッチの保存を行う） |
| `kimi_setup` | `action`: `check`（既定）、`models`、`install`、`install_kimi`、`repair_sessions` | `~/.kimi-code/config.toml` のフックブロック、プラグイン専用 CLI、またはセッションプレビューを更新 |

`kimi_read` と `kimi_write` に対する標準の `tools/call` リクエストは、既定で最大 50 秒待機し（`wait: true`）、回答を直接返します。`wait_timeout_ms` は最大 `86400000` ミリ秒（24 時間）まで延長できます。クライアントが切断または待機をキャンセルするとポーリングは止まりますが、Kimi ジョブ自体は継続します。

並列タスクを起動するときにすぐ `{ job_id }` を受け取るには、`wait: false` を指定してください。その後、`kimi_job` で各ジョブの確認、待機、停止を行えます。MCP `2026-07-28` タスク（`io.modelcontextprotocol/tasks`）に対応したクライアントは、`tasks/get` と `tasks/cancel` 用のネイティブタスクハンドルを受け取ります。

ホストが既定のプロジェクトディレクトリを設定しない場合は、絶対パスで `workspace` を渡してください。`Warnings:` ブロックが返された場合は、必ずユーザーにそのまま伝えてください。

## ターミナルから Kimi を使う

`scripts/companion.sh` から 5 つの主要 CLI サブコマンドを直接実行できます：

| コマンド | 動作内容 |
| --- | --- |
| `scripts/companion.sh read [--mode ask\|review\|challenge\|swarm] [options] [--] [prompt]` | 読み取り専用の質問、差分レビュー（`--base <ref>`）、設計への批評、または並列の読み取り専用スウォームを実行 |
| `scripts/companion.sh write [--mode rescue\|pursue\|swarm-patch] [options] [--] <prompt>` | ワークスペース内の修正、複数ステップのゴール、または一時ワークツリーでのパッチスウォームを実行 |
| `scripts/companion.sh job <list\|status\|result\|wait\|cancel\|replay\|recover-swarm> [job-id]` | ジョブの一覧表示、状態確認、結果取得、待機、停止、再出力、復旧を実行 |
| `scripts/companion.sh setup [--check\|--uninstall\|--models\|--install-kimi\|--repair-sessions]` | フックの導入と確認、モデル一覧表示、認定済み Kimi `2.8.0` の導入、セッションプレビューの修復を実行 |
| `scripts/companion.sh mcp` | stdio MCP サーバーを起動 |

`--mode` などのフラグは `--` またはプロンプトの前に置いてください。`ask`、`review`、`task rescue`、`status`、`result`、`cancel` といった旧サブコマンドも互換エイリアスとしてそのまま使えます。

## 前のセッションを参照する

MCP の `referenced_sessions` または CLI の `--reference-session <id>` を使うと、1 から 8 個の過去のジョブ ID または Kimi セッション ID を渡せます。セッション参照は `ask`、`review`、`challenge`、`rescue`、`swarm`、`swarm_patch` で利用でき、`pursue` では使えません：

```sh
scripts/companion.sh read --reference-session <job-id> -- Continue the migration from where that session stopped.
```

Kimi は各セッションのメインログへのパスを受け取り、必要な箇所だけを読み取ります。`read_roots` または `network` を指定した場合、参照した各セッションの `agents/main` ディレクトリが読み取り許可ルートに追加されます。そのセッションログの内容がマシン外へ送信されても問題ない場合にのみ、`network` と組み合わせてください。

## 読み取り範囲とネットワークアクセスを制限する

既定では、読み取り専用タスクはユーザーアカウントが読み取れる任意のファイルを読み取ることができ、ウェブにはアクセスできません。`kimi_read`（`ask`、`review`、`challenge`、`swarm`）および `companion.sh read` では、次の 2 つのオプションで範囲を制限できます：

- `read_roots` または `--read-root <abs-dir>`（複数指定可）は、`Read`、`Grep`、`Glob`、`ReadMediaFile` の読み取り対象をワークスペースと指定ディレクトリだけに制限する
- `network: true` または `--network` は、公開ホストへの `WebSearch` と `FetchURL` を許可し、4 つの読み取りツールをワークスペースと指定ディレクトリだけに制限する

書き込みタスクではこれら 2 つのオプションを指定できません。読み取り範囲とネットワーク制限はその 1 回の実行にのみ適用され、再開したターンには引き継がれません。

## Kimi 更新時も動作を維持する

プラグイン 3.1.0 は Kimi Code `2.8.0` 以降のローリング互換ウィンドウを採用しています：

- 完全一致の `2.8.0` は全 7 操作を実行できる
- `2.8.0` より新しい未登録の通常版 `2.y.z` は、警告付きかつ `--environment local` で読み取り専用の `ask`、`review`、`challenge` を実行できる
- `2.8.0` より新しい未登録の通常版 `2.y.z` は、書き込みタスク、スウォームタスク、`--network` を `KIMI_CAPABILITY_NOT_CERTIFIED` で拒否する
- `2.8.0` 未満のリリースはすべての操作を拒否する

すべてのホストで共有される認定済みバイナリで全 7 操作を利用し続けるには、`kimi_setup({ action: "install_kimi" })` または `scripts/companion.sh setup --install-kimi` を実行してください。ネットワークからファイルをダウンロードするのはこのコマンドだけです。ジョブは `KIMI_PLUGIN_CC_KIMI_BIN`、共有データディレクトリ内の `<data-dir>/kimi-bin/current`、`PATH` 上の `kimi` の順に選択します。

## 単一のデータディレクトリと安全フックを共有する

全 5 ホストは、1 つのデータディレクトリ（`<data-dir>`）と `<data-dir>/hook/approval-hook.js` にある 1 つのバンドル済み PreToolUse 安全フックを共有します。既定のデータディレクトリは、macOS と Linux では `~/.local/share/kimi-plugin-cc`（または `$XDG_DATA_HOME/kimi-plugin-cc`）、Windows では `%LOCALAPPDATA%\kimi-plugin-cc` です。親ディレクトリを `KIMI_PLUGIN_CC_DATA` で上書きすると、データは `$KIMI_PLUGIN_CC_DATA/kimi-plugin-cc` に保存されます。

`setup` を 1 回実行すると、バンドル済みフックが配置され、`~/.kimi-code/config.toml` に単一の `# === BEGIN kimi-plugin-cc-managed (v3.1.2) ===` ブロックが書き込まれます。バージョン 3.0 の古い `:<host-id>` ブロックも自動的に統合されます。同じ Node バイナリを使うホスト間では、`setup` の実行は 1 回だけで十分です。ホストごとに異なる Node パスが解決される場合は、`KIMI_PLUGIN_CC_NODE_BIN` で同じ Node バイナリを指定してください。

## セッション、モデル、ジョブを管理する

セッションは Kimi Code Desktop と `kimi web` に表示され、元のリクエスト文がプレビューになります。プレビューを修復するには、`kimi_setup({ action: "repair_sessions" })` または `scripts/companion.sh setup --repair-sessions [--apply] [--all]` を実行してください。詳しくは [セッションの表示とタイトル](./docs/session-visibility.md) を参照してください。

設定済みのモデルエイリアスをオフラインで一覧表示するには、`kimi_setup({ action: "models" })` または `scripts/companion.sh setup --models [--json]` を実行します。1 回の実行だけモデルを指定するには MCP の `model` または CLI の `-m` を渡し、既定のモデルを変更するには `kimi` 内で `/model` を実行してください。詳しくは [モデル選択](./docs/models.md) を参照してください。

ジョブの追跡や停止には `kimi_job`（`list`、`status`、`result`、`wait`、`cancel`、`replay`、`recover_swarm`）または `scripts/companion.sh job` を使います。`swarm_patch` がパッチを保存できるよう、ホストを強制終了するのではなく、必ず `kimi_job` または `job cancel` で停止してください。中断された実行の復旧については [スウォームの復旧](./docs/swarm-recovery.md) を参照してください。

管理対象の安全フックを削除するには、`scripts/companion.sh setup --uninstall` を実行します。バージョン 3.0 からアップグレードする場合は、[3.0 から 3.1 へのアップグレード](./docs/migration.md#upgrading-from-30-to-31) を確認してください。

## 安全上の制限を理解する

単一の PreToolUse 安全フックが Kimi のすべてのツール呼び出しを検査します：

- 読み取り専用タスクはファイルの編集とシェルコマンドを拒否する
- 書き込みタスクはワークスペース内のファイルだけを編集し、Git の状態を変更しない
- `swarm_patch` は `HEAD` から作成した一時的な Git ワークツリー内で編集し、未適用のパッチを返す

このプラグインは次のことを行いません：

- `read_roots` または `network` を指定しない限り、ファイルの読み取り範囲を制限しない
- `FetchURL` が記述された URL を検証した後の DNS 解決や HTTP リダイレクトを検査しない
- 書き込みタスクが起動したリポジトリのテストランナーを OS レベルでサンドボックス化しない
- パッチの適用や Git コミットの作成を行わない

書き込みタスクは信頼できるリポジトリでのみ実行してください。拒否コードとリリース履歴については、[安全性と拒否コード](./docs/safety.md#native-v2-refusal-codes) と [変更履歴](./CHANGELOG.md) を参照してください。

## 問題の報告とコントリビュート

バグの報告や変更の提案は [GitHub issues](https://github.com/linxule/kimi-plugin-cc/issues) で受け付けています。コントリビューターは [ランタイム不変条件](./docs/invariants.md) と [継続的インテグレーションの詳細](./docs/ci.md) を参照してください。

</details>

---

This plugin uses [Kimi Code](https://github.com/MoonshotAI/kimi-code). Its runtime design draws on [OpenAI's codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Licensed under [Apache-2.0](./LICENSE).
