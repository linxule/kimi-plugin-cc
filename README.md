# Kimi for Claude Code, Codex, and DeepSeek Harness

[![Latest release](https://img.shields.io/github/v/release/linxule/kimi-plugin-cc)](https://github.com/linxule/kimi-plugin-cc/releases/latest) [![CI](https://github.com/linxule/kimi-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/kimi-plugin-cc/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Use Kimi to explain code, review changes, challenge a design, or work toward a goal — an independent second opinion from a different model family, inside the Claude Code, Codex, or DeepSeek Harness session you're already in.

[![Kimi Ambassador — academia](./assets/kimi-ambassador-academia.webp)](https://www.kimi.ai/lp/kimi-ambassador)

I'm a [Kimi Ambassador](https://www.kimi.ai/lp/kimi-ambassador) (academia). Kimi (Moonshot AI) supports this project through that role.

[Latest release](https://github.com/linxule/kimi-plugin-cc/releases/latest) · [npm package](https://www.npmjs.com/package/kimi-plugin-cc) · [Roadmap](./ROADMAP-TO-GA.md) · [Report an issue](https://github.com/linxule/kimi-plugin-cc/issues) · [Apache-2.0 license](./LICENSE)

![Claude Code running /kimi:review on this repository, with Kimi's findings verified claim by claim in the same session](./assets/claude-code-kimi-review.jpg)

*Claude Code runs `/kimi:review` on this repository — Kimi reviews the diff, and the host verifies each claim against the tree.*

Choose a language below. Each guide opens on this page.

选择语言，展开阅读 · Choisissez votre langue · 言語を選んで開いてください

<details open>
<summary>English — Get started</summary>

## Use Kimi in your coding tasks

Send questions, code reviews, bounded fixes, autonomous goals and parallel swarms to the Kimi Code CLI from Claude Code, Codex or DeepSeek Harness (DSH).

The plugin runs Kimi on your computer with your Kimi subscription or API provider. It does not change your host login. Your provider receives the prompts and code each task needs.

Read-only tasks cannot edit files or run shell commands. Tasks that write stay inside your workspace or a temporary Git worktree.

## Before you install

You need:

- macOS or Linux
- Claude Code, Codex, or DSH `>=0.2.1-rc.5 <0.3.0`, with plugin support
- Node.js 22.5 or newer (24.9 or newer for DSH)
- Kimi Code CLI 2.7.3 for every task, including swarm; exact 2.6.2, 2.6.3 and 2.7.2 work the same way

Windows is not supported. Contributors can help with the [no-model Windows diagnostics checks](./docs/windows-validation.md).

Use the [Kimi Code installation guide](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) if you need the CLI. You do not need Bun or a build step. Older supported versions and their limits are in the [runtime matrix](./docs/native-v2-certification-provenance.md) and [supported versions and upgrades](./docs/migration.md).

Run `kimi` in your terminal. Use `/login` for a Kimi subscription, or `/provider` to set up an API provider. Enter credentials in Kimi, never in the assistant conversation. If you set `KIMI_CODE_HOME`, use the same location for Kimi and the plugin.

## Install in Claude Code

Open Claude Code in your project and enter:

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

Setup installs a hook that checks Kimi's tool calls against the plugin's rules. The `Probe:` line should show `ok`. Then try a question that does not change files:

```text
/kimi:task Explain how this project's main entry point works.
```

## Install in Codex

Run these commands in your terminal:

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Open a new Codex task in your project and send:

```text
Use $kimi-setup to install the safety hook, then check readiness.
```

The `Probe:` line should show `ok`. Then try:

```text
Use $kimi-task to explain how this project's main entry point works.
```

## Install in DeepSeek Harness

DSH needs patched host and profile dependencies (`zod >=4.6.6`, `undici >=8.12.2`). Follow the [host installation and audit instructions](./docs/registry-releases.md#patched-dsh-host-and-profiles) first.

From a checkout of this repository, run:

```sh
dsh plugin --profile web add ./plugins/kimi-dsh
```

For the published npm bundle, run `dsh plugin --profile web add kimi-plugin-cc` instead. For DSH Discover, turn on Custom plugin indexes and add `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`.

Restart DSH when asked, then run `/kimi-setup` and `/kimi-setup --check`. See the [DSH bundle guide](./plugins/kimi-dsh/README.md) for profile settings.

## Install from npm (optional)

The marketplace commands above are the default. Releases are also published as [`kimi-plugin-cc` on npm](https://www.npmjs.com/package/kimi-plugin-cc). To pin a version for Claude Code:

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc kimi-plugin-cc@3.0.0
claude --plugin-dir ~/.local/share/kimi-plugin-cc/node_modules/kimi-plugin-cc
```

Run `/kimi:setup`, then `/kimi:setup --check`. Use one installation of the plugin per host: do not load this copy alongside an enabled marketplace copy. Maintainers: see [registry releases](./docs/registry-releases.md).

## Use Kimi from an agent

The plugin includes an MCP server for Claude Code and Codex. If you are an agent, prefer these tools for long-running work: a job keeps running if the connection drops, and a client that supports MCP tasks is notified when it finishes. Other clients get a `job_id` to check.

| Tool | What it does | Can it write? |
| --- | --- | --- |
| `kimi_ask` | Answers a question about the repository | No |
| `kimi_review` | Reviews changes. `mode: "challenge"` questions the approach instead | No |
| `kimi_rescue` | Investigates or makes a bounded fix | Workspace files, never Git |
| `kimi_pursue` | Works toward an objective over several turns (experimental) | Workspace files, never Git |
| `kimi_swarm` | Runs parallel read-only checks across independent targets | No |
| `kimi_swarm_write` | Runs parallel edits in a temporary Git worktree | Returns a patch. It does not apply it |

Use `kimi_job_status`, `kimi_job_result` and `kimi_job_cancel` to follow or stop a job. A result can include `warnings`: pass them on to the user.

`kimi_ask`, `kimi_review` and `kimi_swarm` accept `read_roots` and `network`. See [Limit what a task can read and reach](#limit-what-a-task-can-read-and-reach).

When the host gives no default project directory, as in Codex, pass an absolute `workspace` path.

## Use Kimi yourself

| Command | What it does |
| --- | --- |
| `/kimi:task` | Answers a question. Add `--write` to let Kimi edit files in your workspace |
| `/kimi:review` | Reviews your working tree, or a branch with `--base <ref>`. Add `--challenge` to question the approach |
| `/kimi:pursue` | Works toward an objective over several turns, within a time budget (experimental). It can edit workspace files |
| `/kimi:swarm` | Runs parallel read-only checks. Add `--write` to prepare parallel edits as a patch |
| `/kimi:setup` | Installs or checks the hook, lists models, and installs Kimi |
| `/kimi:status`, `/kimi:result`, `/kimi:cancel`, `/kimi:replay` | Follow, read, stop or replay a task |

Put `--write` or `--challenge` before your prompt.

Version 3.0 merged some commands:

- `/kimi:ask` is now `/kimi:task`
- `/kimi:rescue` is now `/kimi:task --write`
- `/kimi:challenge` is now `/kimi:review --challenge`
- the `kimi_challenge` MCP tool is now `kimi_review` with `mode: "challenge"`

In Codex, use the nine skills, such as `$kimi-task` and `$kimi-review`. In DSH, the seven tools are unchanged, including `kimi_challenge`.

`/kimi:task` can continue a session: `/kimi:task -r Explain the next step.`

## Limit what a task can read and reach

By default a task can read any file on your computer and cannot use the web.

`/kimi:task`, `/kimi:review` and read-only `/kimi:swarm` accept two flags:

- `--read-root <absolute-directory>` limits file reads to your workspace and the directories you name. You can repeat it
- `--network` allows web search and fetching public web pages. It also limits file reads to your workspace and any `--read-root` directories

Tasks that write do not accept these flags. The limits apply to one run. To add `--network` to a session you started without it, start a new one: `/kimi:task --fresh --network`.

The limits apply to files Kimi reads with its tools. A review's diff covers the whole repository, and Kimi's own instruction files, such as `AGENTS.md`, still reach the model.

## When Kimi updates before the plugin does

The plugin checks each Kimi release before it certifies it. If your Kimi is newer than the plugin knows:

- `/kimi:task`, `/kimi:review` and the review gate still run, with a warning
- `/kimi:task --write`, `/kimi:pursue` and `/kimi:swarm` refuse with `KIMI_CAPABILITY_NOT_CERTIFIED`
- `--network` refuses

To keep everything working, run `/kimi:setup --install-kimi` (`/kimi-setup --install-kimi` in DSH). It installs the newest certified Kimi for the plugin's own use and leaves your own `kimi` alone. This is the only command that downloads anything.

Tasks use the first of these that exists: the `KIMI_PLUGIN_CC_KIMI_BIN` path, the plugin's own installed Kimi, then `kimi` on your `PATH`. `/kimi:setup --check` shows which one on the `Kimi binary:` line.

## If you use more than one host

Update the plugin in every host you use, and run setup in each.

Each host adds its own hook to the shared Kimi configuration, and Kimi runs every hook for every task. If one host has an older version of the plugin, its hook applies its older rules to every task, and can block things the newer version allows. A task warns you when this can happen.

## View sessions in Kimi

Plugin sessions appear in Kimi Code Desktop and `kimi web`, with a title such as `Kimi Ask: …` and your request as the preview. Kimi can replace the title with a generated one. Manual renames are kept. See [session visibility and titles](./docs/session-visibility.md).

## Choose a model

New sessions use your default Kimi model. To use another, list your models with `/kimi:setup --models` (in Codex, ask `$kimi-setup` to list them). This reads your local list. It does not contact providers.

Pass an alias from the list with `-m`:

```text
/kimi:review -m 'provider/model' Check error handling in this diff.
```

This does not change your saved default. To change it, run `kimi` and use `/model`. See [model selection and provider setup](./docs/models.md).

## Check or cancel a task

| Action | Claude Code | Codex | DSH |
| --- | --- | --- | --- |
| Check progress | `/kimi:status` | `$kimi-status` | `/kimi-status` |
| Read the result | `/kimi:result` | `$kimi-result` | `/kimi-result` |
| Cancel | `/kimi:cancel` | `$kimi-cancel` | `/kimi-cancel` |

Without a job ID, cancel stops the latest running task for this repository. Use cancel instead of interrupting the app, so a write swarm can save its patch. Canceling does not undo changes a task has already made.

For an interrupted swarm, see [swarm recovery](./docs/swarm-recovery.md).

## Update or remove the plugin

In Claude Code, open `/plugin`, refresh `kimi-marketplace` and update `kimi`. Then run `/kimi:setup` again.

In Codex, run these commands, then open a new task and run `$kimi-setup` again:

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

To remove the plugin, remove its hook first: `/kimi:setup --uninstall` in Claude Code, `$kimi-setup` in Codex, or `/kimi-setup --uninstall` in DSH. This leaves other hosts' hooks in place.

Upgrading from 2.x? See [upgrading to 3.0](./docs/migration.md#upgrading-to-30).

## Fix setup problems

If a hook check fails, follow its diagnosis and run setup for that host. Do not bypass the check.

If you see `KIMI_CAPABILITY_NOT_CERTIFIED`, run `/kimi:setup --install-kimi` or update the plugin.

If a task shows a warning, it still ran. The warning tells you what to fix.

All refusal codes and what to do about them are in the [refusal-code catalog](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100).

## Understand the safety limits

The plugin makes promises about the Kimi sessions it starts. It does not police your own Kimi settings.

A hook checks every tool call Kimi makes and denies anything the task is not allowed to do:

- read-only tasks cannot write files or run shell commands
- tasks that write can only change files inside your workspace, and cannot change Git state
- a write swarm works in a temporary Git worktree from your latest commit and returns a patch. It does not apply it

The plugin does not:

- limit what a task can read, unless you pass `--read-root` or `--network`
- see where a web address leads: a public address can redirect to a private one
- act as a sandbox: tasks that write can run tests and similar commands, and these run code from your repository
- commit anything. Review changes before you keep them

Only run tasks that write in repositories you trust.

See [safety and limitations](./docs/safety.md), [release history](./CHANGELOG.md) and [planned work](./ROADMAP-TO-GA.md).

## Contribute

Report bugs or propose changes in [GitHub issues](https://github.com/linxule/kimi-plugin-cc/issues). Contributors can read the [runtime invariants](./docs/invariants.md) and [CI details](./docs/ci.md).

</details>

<details>
<summary>简体中文 — 开始使用</summary>

## 在编码任务中使用 Kimi

从 Claude Code、Codex 或 DeepSeek Harness（DSH）向 Kimi Code CLI 发送提问、代码审查、限定范围的修复、自主目标和并行 swarm 任务。

该插件使用你的 Kimi 订阅或 API 提供商，在你的电脑上运行 Kimi。它不会更改你的宿主登录状态。你的提供商会接收每个任务所需的提示词和代码。

只读任务不能编辑文件或运行 shell 命令。写入任务限定在你的工作区或临时 Git 工作树内。

## 安装前准备

你需要：

- macOS 或 Linux
- 支持插件的 Claude Code、Codex 或 DSH `>=0.2.1-rc.5 <0.3.0`
- Node.js 22.5 或更高版本（DSH 需 24.9 或更高版本）
- Kimi Code CLI 2.7.3（支持所有任务，包括 swarm）；精确版本 2.6.2、2.6.3 和 2.7.2 的工作方式相同

不支持 Windows。贡献者可以协助完成[无模型 Windows 诊断检查](./docs/windows-validation.md)。

如果你需要该 CLI，请使用 [Kimi Code 安装指南](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started)。你不需要 Bun 或构建步骤。受支持的旧版本及其限制见[运行时矩阵](./docs/native-v2-certification-provenance.md)和[支持的版本与升级](./docs/migration.md)。

在终端中运行 `kimi`。使用 `/login` 登录 Kimi 订阅，或使用 `/provider` 配置 API 提供商。请在 Kimi 中输入凭据，切勿在助手对话中输入。如果你设置了 `KIMI_CODE_HOME`，请为 Kimi 和插件使用相同路径。

## 在 Claude Code 中安装

在你的项目中打开 Claude Code 并输入：

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

设置过程会安装一个钩子，根据插件规则检查 Kimi 的工具调用。`Probe:` 行应显示 `ok`。然后尝试一个不会修改文件的问题：

```text
/kimi:task Explain how this project's main entry point works.
```

## 在 Codex 中安装

在终端中运行以下命令：

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

在你的项目中新建一个 Codex 任务并发送：

```text
Use $kimi-setup to install the safety hook, then check readiness.
```

`Probe:` 行应显示 `ok`。然后尝试：

```text
Use $kimi-task to explain how this project's main entry point works.
```

## 在 DeepSeek Harness 中安装

DSH 需要打过补丁的宿主与配置集依赖项（`zod >=4.6.6`、`undici >=8.12.2`）。请先按照[宿主安装与审计说明](./docs/registry-releases.md#patched-dsh-host-and-profiles)操作。

在本仓库的检出目录中运行：

```sh
dsh plugin --profile web add ./plugins/kimi-dsh
```

若使用已发布的 npm 捆绑包，请改用 `dsh plugin --profile web add kimi-plugin-cc`。若使用 DSH Discover，请开启自定义插件索引并添加 `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`。

出现提示时重启 DSH，然后运行 `/kimi-setup` 和 `/kimi-setup --check`。有关配置集设置，请参见 [DSH 捆绑包指南](./plugins/kimi-dsh/README.md)。

## 从 npm 安装（可选）

上方的插件市场命令是默认安装方式。各版本也会作为 [npm 上的 `kimi-plugin-cc`](https://www.npmjs.com/package/kimi-plugin-cc) 发布。如需为 Claude Code 锁定版本：

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc kimi-plugin-cc@3.0.0
claude --plugin-dir ~/.local/share/kimi-plugin-cc/node_modules/kimi-plugin-cc
```

运行 `/kimi:setup`，然后运行 `/kimi:setup --check`。每个宿主只使用一份插件安装：不要在已启用插件市场副本的同时加载此副本。维护者：参见[注册表发布](./docs/registry-releases.md)。

## 从智能体使用 Kimi

插件包含面向 Claude Code 和 Codex 的 MCP 服务器。如果你是智能体，处理耗时较长的工作时请优先使用这些工具：即使连接断开，作业也会继续运行；支持 MCP 任务的客户端会在作业完成时收到通知。其他客户端会获得一个可供查询的 `job_id`。

| 工具 | 作用 | 能否写入？ |
| --- | --- | --- |
| `kimi_ask` | 回答关于代码仓库的问题 | 否 |
| `kimi_review` | 审查改动。`mode: "challenge"` 则改为质疑实现方案 | 否 |
| `kimi_rescue` | 排查问题或执行限定范围的修复 | 工作区文件，绝不修改 Git |
| `kimi_pursue` | 通过多轮执行推进目标（实验性） | 工作区文件，绝不修改 Git |
| `kimi_swarm` | 针对多个独立目标并行运行只读检查 | 否 |
| `kimi_swarm_write` | 在临时 Git 工作树中并行执行编辑 | 返回补丁。不会应用该补丁 |

使用 `kimi_job_status`、`kimi_job_result` 和 `kimi_job_cancel` 跟进或停止作业。结果可能包含 `warnings`：请将其转达给用户。

`kimi_ask`、`kimi_review` 和 `kimi_swarm` 接受 `read_roots` 和 `network`。参见[限制任务可读取和访问的范围](#限制任务可读取和访问的范围)。

当宿主未提供默认项目目录时（例如在 Codex 中），请传入绝对路径作为 `workspace`。

## 自行使用 Kimi

| 命令 | 作用 |
| --- | --- |
| `/kimi:task` | 回答问题。加上 `--write` 可让 Kimi 编辑工作区中的文件 |
| `/kimi:review` | 审查工作树，或配合 `--base <ref>` 审查分支。加上 `--challenge` 可质疑实现方案 |
| `/kimi:pursue` | 在时间预算内通过多轮执行推进目标（实验性）。它可以编辑工作区文件 |
| `/kimi:swarm` | 并行运行只读检查。加上 `--write` 可将并行编辑准备为补丁 |
| `/kimi:setup` | 安装或检查钩子、列出模型，以及安装 Kimi |
| `/kimi:status`、`/kimi:result`、`/kimi:cancel`、`/kimi:replay` | 跟进、读取、停止或回放任务 |

请将 `--write` 或 `--challenge` 放在提示词前面。

3.0 版本合并了部分命令：

- `/kimi:ask` 现已改为 `/kimi:task`
- `/kimi:rescue` 现已改为 `/kimi:task --write`
- `/kimi:challenge` 现已改为 `/kimi:review --challenge`
- MCP 工具 `kimi_challenge` 现已改为带 `mode: "challenge"` 的 `kimi_review`

在 Codex 中，请使用九个技能，例如 `$kimi-task` 和 `$kimi-review`。在 DSH 中，包括 `kimi_challenge` 在内的七个工具保持不变。

`/kimi:task` 可以继续已有会话：`/kimi:task -r Explain the next step.`

## 限制任务可读取和访问的范围

默认情况下，任务可以读取你电脑上的任何文件，且不能访问网络。

`/kimi:task`、`/kimi:review` 和只读的 `/kimi:swarm` 接受两个标志：

- `--read-root <absolute-directory>` 将文件读取范围限制在你的工作区和你指定的目录内。你可以重复指定该标志
- `--network` 允许网页搜索和抓取公开网页。它同时会将文件读取范围限制在你的工作区和所有 `--read-root` 目录内

写入任务不接受这些标志。这些限制仅对单次运行生效。要为启动时未带 `--network` 的会话添加该标志，请启动新会话：`/kimi:task --fresh --network`。

这些限制适用于 Kimi 使用其工具读取的文件。审查的 diff 覆盖整个仓库，而 Kimi 自身的指令文件（例如 `AGENTS.md`）仍会送达模型。

## 当 Kimi 先于插件更新时

插件会先检查每个 Kimi 发布版本，然后再予以认证。如果你的 Kimi 比插件已知的版本更新：

- `/kimi:task`、`/kimi:review` 和审查门禁仍会运行，但会显示警告
- `/kimi:task --write`、`/kimi:pursue` 和 `/kimi:swarm` 会以 `KIMI_CAPABILITY_NOT_CERTIFIED` 拒绝执行
- `--network` 会拒绝执行

要让所有功能保持可用，请运行 `/kimi:setup --install-kimi`（在 DSH 中为 `/kimi-setup --install-kimi`）。它会安装最新通过认证的 Kimi 供插件专用，不会改动你自己的 `kimi`。这是唯一会执行下载的命令。

任务按顺序使用以下第一个存在的程序：`KIMI_PLUGIN_CC_KIMI_BIN` 路径、插件自行安装的 Kimi，然后是你 `PATH` 中的 `kimi`。`/kimi:setup --check` 会在 `Kimi binary:` 行显示所使用的是哪一个。

## 如果你使用多个宿主

请在你使用的每个宿主中更新插件，并分别运行设置命令。

每个宿主都会将自己的 hook 添加到共享的 Kimi 配置中，而 Kimi 会为每个任务运行每个 hook。如果某个宿主的插件版本较旧，它的 hook 会将其旧规则应用到每个任务，并可能阻止新版本允许的操作。可能发生这种情况时，任务会向你发出警告。

## 在 Kimi 中查看会话

插件会话会显示在 Kimi Code Desktop 和 `kimi web` 中，标题例如 `Kimi Ask: …`，预览内容为你的请求。Kimi 可以将其替换为生成的标题。手动重命名会保留。参见[会话可见性与标题](./docs/session-visibility.md)。

## 选择模型

新会话使用你的默认 Kimi 模型。如需改用其他模型，请使用 `/kimi:setup --models` 列出你的模型（在 Codex 中，请让 `$kimi-setup` 列出）。这会读取你的本地列表。它不会连接提供商。

使用 `-m` 传入列表中的别名：

```text
/kimi:review -m 'provider/model' Check error handling in this diff.
```

这不会更改你已保存的默认设置。如需更改，请运行 `kimi` 并使用 `/model`。参见[模型选择与提供商配置](./docs/models.md)。

## 查看或取消任务

| 操作 | Claude Code | Codex | DSH |
| --- | --- | --- | --- |
| 查看进度 | `/kimi:status` | `$kimi-status` | `/kimi-status` |
| 读取结果 | `/kimi:result` | `$kimi-result` | `/kimi-result` |
| 取消 | `/kimi:cancel` | `$kimi-cancel` | `/kimi-cancel` |

不指定作业 ID 时，取消操作会停止当前仓库最近一个正在运行的任务。请使用取消命令而不要直接中断应用，以便写入型 swarm保存补丁。取消不会撤销任务已经做出的改动。

对于已中断的 swarm，请参见[swarm 恢复](./docs/swarm-recovery.md)。

## 更新或移除插件

在 Claude Code 中，打开 `/plugin`，刷新 `kimi-marketplace` 并更新 `kimi`。然后再次运行 `/kimi:setup`。

在 Codex 中，运行以下命令，然后新建一个任务并再次运行 `$kimi-setup`：

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

要移除插件，请先移除它的钩子：在 Claude Code 中运行 `/kimi:setup --uninstall`，在 Codex 中使用 `$kimi-setup`，或在 DSH 中运行 `/kimi-setup --uninstall`。这会保留其他宿主的钩子。

从 2.x 升级？参见[升级到 3.0](./docs/migration.md#upgrading-to-30)。

## 解决设置问题

如果钩子检查失败，请按照诊断说明操作，并为该宿主运行设置命令。不要绕过检查。

如果看到 `KIMI_CAPABILITY_NOT_CERTIFIED`，请运行 `/kimi:setup --install-kimi` 或更新插件。

如果任务显示警告，该任务仍然已经运行。警告会说明需要修复的问题。

所有拒绝码及其处理方式见[拒绝码目录](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100)。

## 了解安全限制

插件对由它启动的 Kimi 会话作出保证。它不会管控你自己的 Kimi 设置。

钩子会检查 Kimi 发起的每次工具调用，并拒绝任务无权执行的操作：

- 只读任务不能写入文件或运行 shell 命令
- 写入任务只能修改工作区内的文件，且不能更改 Git 状态
- 写入型 swarm基于你的最新提交在临时 Git 工作树中运行，并返回补丁。它不会应用该补丁

插件不会：

- 限制任务可读取的内容，除非你传入 `--read-root` 或 `--network`
- 查看网址的最终指向：公开地址可能会重定向到私有地址
- 充当沙盒：写入任务可以运行测试及类似命令，而这些命令会执行仓库中的代码
- 提交任何内容。保留改动前请先自行审查

请仅在你信任的代码仓库中运行写入任务。

参见[安全性与限制](./docs/safety.md)、[发布历史](./CHANGELOG.md)和[后续计划](./ROADMAP-TO-GA.md)。

## 参与贡献

请在 [GitHub 问题](https://github.com/linxule/kimi-plugin-cc/issues)中报告缺陷或提出修改建议。贡献者可以阅读[运行时不变量](./docs/invariants.md)和 [CI 详情](./docs/ci.md)。

</details>

<details>
<summary>Français — Bien démarrer</summary>

## Utiliser Kimi dans vos tâches de développement

Envoyez des questions, des revues de code, des correctifs délimités, des objectifs autonomes et des swarms parallèles à la CLI Kimi Code depuis Claude Code, Codex ou DeepSeek Harness (DSH).

Le plugin exécute Kimi sur votre ordinateur avec votre abonnement Kimi ou votre fournisseur d'API. Il ne modifie pas la connexion de votre hôte. Votre fournisseur reçoit les prompts et le code nécessaires à chaque tâche.

Les tâches en lecture seule ne peuvent ni modifier de fichiers ni exécuter de commandes shell. Les tâches en écriture restent dans votre espace de travail ou dans un arbre de travail Git temporaire.

## Avant l'installation

Il vous faut :

- macOS ou Linux
- Claude Code, Codex ou DSH `>=0.2.1-rc.5 <0.3.0`, avec prise en charge des plugins
- Node.js 22.5 ou plus récent (24.9 ou plus récent pour DSH)
- Kimi Code CLI 2.7.3 pour toutes les tâches, y compris les swarms ; les versions exactes 2.6.2, 2.6.3 et 2.7.2 fonctionnent de la même manière

Windows n'est pas pris en charge. Les contributeurs peuvent aider avec les [vérifications de diagnostic Windows sans modèle](./docs/windows-validation.md).

Consultez le [guide d'installation de Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) si vous avez besoin de la CLI. Vous n'avez besoin ni de Bun ni d'une étape de compilation. Les versions plus anciennes prises en charge et leurs limites figurent dans la [matrice d'exécution](./docs/native-v2-certification-provenance.md) et dans [versions prises en charge et mises à niveau](./docs/migration.md).

Exécutez `kimi` dans votre terminal. Utilisez `/login` pour un abonnement Kimi, ou `/provider` pour configurer un fournisseur d'API. Saisissez vos identifiants dans Kimi, jamais dans la conversation avec l'assistant. Si vous définissez `KIMI_CODE_HOME`, utilisez le même emplacement pour Kimi et pour le plugin.

## Installer dans Claude Code

Ouvrez Claude Code dans votre projet et saisissez :

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

La configuration installe un hook qui vérifie les appels d'outils de Kimi par rapport aux règles du plugin. La ligne `Probe:` doit afficher `ok`. Essayez ensuite une question qui ne modifie aucun fichier :

```text
/kimi:task Explain how this project's main entry point works.
```

## Installer dans Codex

Exécutez ces commandes dans votre terminal :

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Ouvrez une nouvelle tâche Codex dans votre projet et envoyez :

```text
Use $kimi-setup to install the safety hook, then check readiness.
```

La ligne `Probe:` doit afficher `ok`. Essayez ensuite :

```text
Use $kimi-task to explain how this project's main entry point works.
```

## Installer dans DeepSeek Harness

DSH nécessite des dépendances corrigées pour l'hôte et les profils (`zod >=4.6.6`, `undici >=8.12.2`). Suivez d'abord les [instructions d'installation et d'audit de l'hôte](./docs/registry-releases.md#patched-dsh-host-and-profiles).

Depuis une copie locale de ce dépôt, exécutez :

```sh
dsh plugin --profile web add ./plugins/kimi-dsh
```

Pour le paquet npm publié, exécutez plutôt `dsh plugin --profile web add kimi-plugin-cc`. Pour DSH Discover, activez les index de plugins personnalisés et ajoutez `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`.

Redémarrez DSH lorsque cela vous est demandé, puis exécutez `/kimi-setup` et `/kimi-setup --check`. Consultez le [guide du paquet DSH](./plugins/kimi-dsh/README.md) pour les paramètres de profil.

## Installer depuis npm (facultatif)

Les commandes de marketplace ci-dessus constituent la méthode par défaut. Les versions sont également publiées sous [`kimi-plugin-cc` sur npm](https://www.npmjs.com/package/kimi-plugin-cc). Pour figer une version dans Claude Code :

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc kimi-plugin-cc@3.0.0
claude --plugin-dir ~/.local/share/kimi-plugin-cc/node_modules/kimi-plugin-cc
```

Exécutez `/kimi:setup`, puis `/kimi:setup --check`. Utilisez une seule installation du plugin par hôte : ne chargez pas cette copie en même temps qu'une copie activée depuis la marketplace. Mainteneurs : consultez [publications sur les registres](./docs/registry-releases.md).

## Utiliser Kimi depuis un agent

Le plugin inclut un serveur MCP pour Claude Code et Codex. Si vous êtes un agent, privilégiez ces outils pour les traitements longs : un job continue de s'exécuter si la connexion est coupée, et un client qui prend en charge les tâches MCP est notifié lorsqu'il se termine. Les autres clients reçoivent un `job_id` à vérifier.

| Outil | Ce qu'il fait | Peut-il écrire ? |
| --- | --- | --- |
| `kimi_ask` | Répond à une question sur le dépôt | Non |
| `kimi_review` | Examine les modifications. `mode: "challenge"` remet plutôt en question l'approche | Non |
| `kimi_rescue` | Enquête ou applique un correctif délimité | Fichiers de l'espace de travail, jamais Git |
| `kimi_pursue` | Avance vers un objectif sur plusieurs tours (expérimental) | Fichiers de l'espace de travail, jamais Git |
| `kimi_swarm` | Exécute des vérifications parallèles en lecture seule sur des cibles indépendantes | Non |
| `kimi_swarm_write` | Exécute des modifications parallèles dans un arbre de travail Git temporaire | Renvoie un patch. Il ne l'applique pas |

Utilisez `kimi_job_status`, `kimi_job_result` et `kimi_job_cancel` pour suivre ou arrêter un job. Un résultat peut contenir des `warnings` : transmettez-les à l'utilisateur.

`kimi_ask`, `kimi_review` et `kimi_swarm` acceptent `read_roots` et `network`. Consultez [Limiter ce qu'une tâche peut lire et atteindre](#limiter-ce-quune-tâche-peut-lire-et-atteindre).

Lorsque l'hôte ne fournit aucun répertoire de projet par défaut, comme dans Codex, passez un chemin `workspace` absolu.

## Utiliser Kimi vous-même

| Commande | Ce qu'elle fait |
| --- | --- |
| `/kimi:task` | Répond à une question. Ajoutez `--write` pour laisser Kimi modifier les fichiers de votre espace de travail |
| `/kimi:review` | Examine votre arbre de travail, ou une branche avec `--base <ref>`. Ajoutez `--challenge` pour remettre en question l'approche |
| `/kimi:pursue` | Avance vers un objectif sur plusieurs tours, dans la limite d'un budget de temps (expérimental). Elle peut modifier les fichiers de l'espace de travail |
| `/kimi:swarm` | Exécute des vérifications parallèles en lecture seule. Ajoutez `--write` pour préparer des modifications parallèles sous forme de patch |
| `/kimi:setup` | Installe ou vérifie le hook, liste les modèles et installe Kimi |
| `/kimi:status`, `/kimi:result`, `/kimi:cancel`, `/kimi:replay` | Suivre, lire, arrêter ou rejouer une tâche |

Placez `--write` ou `--challenge` avant votre prompt.

La version 3.0 a fusionné certaines commandes :

- `/kimi:ask` est désormais `/kimi:task`
- `/kimi:rescue` est désormais `/kimi:task --write`
- `/kimi:challenge` est désormais `/kimi:review --challenge`
- l'outil MCP `kimi_challenge` est désormais `kimi_review` avec `mode: "challenge"`

Dans Codex, utilisez les neuf compétences, telles que `$kimi-task` et `$kimi-review`. Dans DSH, les sept outils sont inchangés, y compris `kimi_challenge`.

`/kimi:task` peut poursuivre une session : `/kimi:task -r Explain the next step.`

## Limiter ce qu'une tâche peut lire et atteindre

Par défaut, une tâche peut lire n'importe quel fichier sur votre ordinateur et ne peut pas utiliser le web.

`/kimi:task`, `/kimi:review` et `/kimi:swarm` en lecture seule acceptent deux options :

- `--read-root <absolute-directory>` limite la lecture de fichiers à votre espace de travail et aux répertoires que vous indiquez. Vous pouvez la répéter
- `--network` autorise la recherche web et la récupération de pages web publiques. Elle limite aussi la lecture de fichiers à votre espace de travail et aux éventuels répertoires `--read-root`

Les tâches en écriture n'acceptent pas ces options. Ces limites s'appliquent à une seule exécution. Pour ajouter `--network` à une session démarrée sans cette option, démarrez-en une nouvelle : `/kimi:task --fresh --network`.

Les limites s'appliquent aux fichiers que Kimi lit avec ses outils. Le diff d'une revue couvre tout le dépôt, et les fichiers d'instructions propres à Kimi, comme `AGENTS.md`, atteignent toujours le modèle.

## Quand Kimi est mis à jour avant le plugin

Le plugin vérifie chaque version de Kimi avant de la certifier. Si votre version de Kimi est plus récente que celles connues du plugin :

- `/kimi:task`, `/kimi:review` et le contrôle de revue s'exécutent quand même, avec un avertissement
- `/kimi:task --write`, `/kimi:pursue` et `/kimi:swarm` refusent l'exécution avec `KIMI_CAPABILITY_NOT_CERTIFIED`
- `--network` est refusé

Pour que tout continue de fonctionner, exécutez `/kimi:setup --install-kimi` (`/kimi-setup --install-kimi` dans DSH). Cette commande installe la dernière version certifiée de Kimi pour l'usage interne du plugin et laisse votre propre `kimi` intact. C'est la seule commande qui télécharge quoi que ce soit.

Les tâches utilisent le premier élément existant dans cet ordre : le chemin `KIMI_PLUGIN_CC_KIMI_BIN`, le Kimi installé par le plugin, puis `kimi` dans votre `PATH`. `/kimi:setup --check` indique lequel est utilisé sur la ligne `Kimi binary:`.

## Si vous utilisez plusieurs hôtes

Mettez à jour le plugin dans chaque hôte que vous utilisez, et exécutez la configuration dans chacun d'eux.

Chaque hôte ajoute son propre hook à la configuration Kimi partagée, et Kimi exécute chaque hook pour chaque tâche. Si un hôte a une version plus ancienne du plugin, son hook applique ses règles plus anciennes à chaque tâche, et peut bloquer ce que la version plus récente autorise. Une tâche vous avertit lorsque cela peut se produire.

## Afficher les sessions dans Kimi

Les sessions du plugin apparaissent dans Kimi Code Desktop et `kimi web`, avec un titre tel que `Kimi Ask: …` et votre requête en aperçu. Kimi peut remplacer ce titre par un titre généré. Les renommages manuels sont conservés. Consultez [visibilité et titres des sessions](./docs/session-visibility.md).

## Choisir un modèle

Les nouvelles sessions utilisent votre modèle Kimi par défaut. Pour en utiliser un autre, affichez la liste de vos modèles avec `/kimi:setup --models` (dans Codex, demandez à `$kimi-setup` de les lister). Cette commande lit votre liste locale. Elle ne contacte aucun fournisseur.

Passez un alias de la liste avec `-m` :

```text
/kimi:review -m 'provider/model' Check error handling in this diff.
```

Cela ne modifie pas votre modèle par défaut enregistré. Pour le modifier, lancez `kimi` et utilisez `/model`. Consultez [sélection du modèle et configuration des fournisseurs](./docs/models.md).

## Vérifier ou annuler une tâche

| Action | Claude Code | Codex | DSH |
| --- | --- | --- | --- |
| Vérifier l'avancement | `/kimi:status` | `$kimi-status` | `/kimi-status` |
| Lire le résultat | `/kimi:result` | `$kimi-result` | `/kimi-result` |
| Annuler | `/kimi:cancel` | `$kimi-cancel` | `/kimi-cancel` |

Sans identifiant de job, l'annulation arrête la dernière tâche en cours pour ce dépôt. Utilisez la commande d'annulation plutôt que d'interrompre l'application, afin qu'un swarm en écriture puisse enregistrer son patch. L'annulation ne défait pas les modifications qu'une tâche a déjà effectuées.

Pour un swarm interrompu, consultez [récupération d'un swarm](./docs/swarm-recovery.md).

## Mettre à jour ou supprimer le plugin

Dans Claude Code, ouvrez `/plugin`, actualisez `kimi-marketplace` et mettez à jour `kimi`. Exécutez ensuite à nouveau `/kimi:setup`.

Dans Codex, exécutez ces commandes, puis ouvrez une nouvelle tâche et relancez `$kimi-setup` :

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

Pour supprimer le plugin, supprimez d'abord son hook : `/kimi:setup --uninstall` dans Claude Code, `$kimi-setup` dans Codex, ou `/kimi-setup --uninstall` dans DSH. Cela laisse en place les hooks des autres hôtes.

Vous mettez à niveau depuis 2.x ? Consultez [mise à niveau vers 3.0](./docs/migration.md#upgrading-to-30).

## Résoudre les problèmes de configuration

Si une vérification du hook échoue, suivez son diagnostic et exécutez la configuration pour cet hôte. Ne contournez pas la vérification.

Si vous voyez `KIMI_CAPABILITY_NOT_CERTIFIED`, exécutez `/kimi:setup --install-kimi` ou mettez à jour le plugin.

Si une tâche affiche un avertissement, elle s'est tout de même exécutée. L'avertissement vous indique quoi corriger.

Tous les codes de refus et la marche à suivre figurent dans le [catalogue des codes de refus](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100).

## Comprendre les limites de sécurité

Le plugin offre des garanties sur les sessions Kimi qu'il démarre. Il ne contrôle pas vos propres paramètres Kimi.

Un hook vérifie chaque appel d'outil effectué par Kimi et refuse tout ce que la tâche n'est pas autorisée à faire :

- les tâches en lecture seule ne peuvent ni écrire de fichiers ni exécuter de commandes shell
- les tâches en écriture ne peuvent modifier que les fichiers situés dans votre espace de travail, et ne peuvent pas modifier l'état Git
- un swarm en écriture travaille dans un arbre de travail Git temporaire créé à partir de votre dernier commit et renvoie un patch. Il ne l'applique pas

Ce que le plugin ne fait pas :

- limiter ce qu'une tâche peut lire, sauf si vous passez `--read-root` ou `--network`
- voir où mène une adresse web : une adresse publique peut rediriger vers une adresse privée
- agir comme un bac à sable : les tâches en écriture peuvent exécuter des tests et des commandes similaires, qui exécutent du code issu de votre dépôt
- créer de commit. Relisez les modifications avant de les conserver

N'exécutez des tâches en écriture que dans des dépôts auxquels vous faites confiance.

Consultez [sécurité et limites](./docs/safety.md), [historique des versions](./CHANGELOG.md) et [travaux prévus](./ROADMAP-TO-GA.md).

## Contribuer

Signalez des bugs ou proposez des modifications dans les [tickets GitHub](https://github.com/linxule/kimi-plugin-cc/issues). Les contributeurs peuvent lire les [invariants d'exécution](./docs/invariants.md) et les [détails de la CI](./docs/ci.md).

</details>

<details>
<summary>日本語 — はじめに</summary>

## コーディングタスクでKimiを使う

Claude Code、Codex、またはDeepSeek Harness（DSH）から、質問、コードレビュー、範囲を限定した修正、自律的に進める目標、並列スウォームをKimi Code CLIに送信できます。

このプラグインは、KimiのサブスクリプションまたはAPIプロバイダーを使い、お使いのコンピューター上でKimiを実行します。ホスト側のログインは変更しません。プロバイダーは、各タスクに必要なプロンプトとコードを受け取ります。

読み取り専用タスクは、ファイルを編集できず、シェルコマンドも実行できません。書き込みを行うタスクは、ワークスペース内または一時的なGitワークツリー内にとどまります。

## インストールする前に

以下が必要です。

- macOSまたはLinux
- プラグインに対応したClaude Code、Codex、またはDSH `>=0.2.1-rc.5 <0.3.0`
- Node.js 22.5以降（DSHの場合は24.9以降）
- スウォームを含むすべてのタスクに対応するKimi Code CLI 2.7.3。バージョンが完全一致する2.6.2、2.6.3、2.7.2も同様に動作します

Windowsには対応していません。コントリビューターは、[モデルを使わないWindows診断チェック](./docs/windows-validation.md)に協力できます。

CLIが必要な場合は、[Kimi Codeのインストールガイド](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started)を使用してください。Bunやビルド手順は不要です。サポートされている旧バージョンとその制限は、[ランタイムマトリックス](./docs/native-v2-certification-provenance.md)と[サポート対象バージョンとアップグレード](./docs/migration.md)に記載されています。

ターミナルで`kimi`を実行します。Kimiのサブスクリプションを使う場合は`/login`を、APIプロバイダーを設定する場合は`/provider`を使用してください。認証情報はKimiに入力し、アシスタントとの会話には絶対に入力しないでください。`KIMI_CODE_HOME`を設定する場合は、Kimiとプラグインで同じ場所を使用してください。

## Claude Codeにインストールする

プロジェクトでClaude Codeを開き、以下を入力します。

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

セットアップは、Kimiのツール呼び出しをプラグインのルールに照らして検査するフックをインストールします。`Probe:`の行に`ok`と表示されるはずです。次に、ファイルを変更しない質問を試してください。

```text
/kimi:task Explain how this project's main entry point works.
```

## Codexにインストールする

ターミナルで以下のコマンドを実行します。

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

プロジェクトで新しいCodexタスクを開き、以下を送信します。

```text
Use $kimi-setup to install the safety hook, then check readiness.
```

`Probe:`の行に`ok`と表示されるはずです。次に、以下を試してください。

```text
Use $kimi-task to explain how this project's main entry point works.
```

## DeepSeek Harnessにインストールする

DSHには、パッチ適用済みのホストおよびプロファイル依存パッケージ（`zod >=4.6.6`、`undici >=8.12.2`）が必要です。先に[ホストのインストールと監査の手順](./docs/registry-releases.md#patched-dsh-host-and-profiles)に従ってください。

このリポジトリをチェックアウトしたディレクトリから、以下を実行します。

```sh
dsh plugin --profile web add ./plugins/kimi-dsh
```

公開済みのnpmバンドルを使う場合は、代わりに`dsh plugin --profile web add kimi-plugin-cc`を実行します。DSH Discoverでは、カスタムプラグインインデックスをオンにして`https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json`を追加してください。

求められたらDSHを再起動し、`/kimi-setup`と`/kimi-setup --check`を実行します。プロファイル設定については、[DSHバンドルガイド](./plugins/kimi-dsh/README.md)を参照してください。

## npmからインストールする（任意）

上記のマーケットプレイスコマンドがデフォルトです。各リリースは[npmの`kimi-plugin-cc`](https://www.npmjs.com/package/kimi-plugin-cc)としても公開されています。Claude Codeでバージョンを固定するには、以下を実行します。

```sh
npm install --prefix ~/.local/share/kimi-plugin-cc kimi-plugin-cc@3.0.0
claude --plugin-dir ~/.local/share/kimi-plugin-cc/node_modules/kimi-plugin-cc
```

`/kimi:setup`を実行し、続けて`/kimi:setup --check`を実行します。プラグインのインストールは1つのホストにつき1つだけにしてください。マーケットプレイス版を有効にしたまま、このコピーを同時に読み込まないでください。メンテナーの方は[レジストリリリース](./docs/registry-releases.md)を参照してください。

## エージェントからKimiを使う

このプラグインには、Claude CodeとCodex向けのMCPサーバーが含まれています。エージェントとして動作している場合は、長時間かかる作業にこれらのツールを優先して使ってください。接続が切れてもジョブは実行を継続し、MCPタスクに対応したクライアントには完了時に通知が届きます。それ以外のクライアントは確認用の`job_id`を受け取ります。

| ツール | 動作内容 | 書き込みできるか |
| --- | --- | --- |
| `kimi_ask` | リポジトリに関する質問に回答します | いいえ |
| `kimi_review` | 変更をレビューします。`mode: "challenge"`を指定すると、代わりにアプローチ自体を問い直します | いいえ |
| `kimi_rescue` | 調査を行うか、範囲を限定した修正を行います | ワークスペース内のファイルのみ。Gitは変更しません |
| `kimi_pursue` | 複数ターンにわたり目標に向けて作業します（実験的） | ワークスペース内のファイルのみ。Gitは変更しません |
| `kimi_swarm` | 独立した対象に対して読み取り専用の並列チェックを実行します | いいえ |
| `kimi_swarm_write` | 一時的なGitワークツリーで並列編集を実行します | パッチを返します。適用はしません |

ジョブの追跡や停止には、`kimi_job_status`、`kimi_job_result`、`kimi_job_cancel`を使用します。結果には`warnings`が含まれることがあります。その場合はユーザーに伝えてください。

`kimi_ask`、`kimi_review`、`kimi_swarm`は`read_roots`と`network`を受け付けます。[タスクの読み取り範囲とアクセス先を制限する](#タスクの読み取り範囲とアクセス先を制限する)を参照してください。

Codexのようにホストからデフォルトのプロジェクトディレクトリが渡されない場合は、`workspace`に絶対パスを渡してください。

## 自分でKimiを使う

| コマンド | 動作内容 |
| --- | --- |
| `/kimi:task` | 質問に回答します。`--write`を付けると、Kimiがワークスペース内のファイルを編集できるようになります |
| `/kimi:review` | 作業ツリーをレビューします。`--base <ref>`を付けるとブランチをレビューします。`--challenge`を付けるとアプローチ自体を問い直します |
| `/kimi:pursue` | 制限時間内で複数ターンにわたり目標に向けて作業します（実験的）。ワークスペース内のファイルを編集できます |
| `/kimi:swarm` | 読み取り専用の並列チェックを実行します。`--write`を付けると、並列編集をパッチとして作成します |
| `/kimi:setup` | フックのインストールや確認、モデルの一覧表示、Kimiのインストールを行います |
| `/kimi:status`、`/kimi:result`、`/kimi:cancel`、`/kimi:replay` | タスクの追跡、結果の読み取り、停止、リプレイを行います |

`--write`や`--challenge`は、プロンプトの前に指定してください。

バージョン3.0で一部のコマンドが統合されました。

- `/kimi:ask`は`/kimi:task`になりました
- `/kimi:rescue`は`/kimi:task --write`になりました
- `/kimi:challenge`は`/kimi:review --challenge`になりました
- MCPツールの`kimi_challenge`は、`mode: "challenge"`を指定した`kimi_review`になりました

Codexでは、`$kimi-task`や`$kimi-review`などの9つのスキルを使用します。DSHでは、`kimi_challenge`を含む7つのツールに変更はありません。

`/kimi:task`では、`/kimi:task -r Explain the next step.`のようにセッションを継続できます。

## タスクの読み取り範囲とアクセス先を制限する

デフォルトでは、タスクはお使いのコンピューター上のどのファイルでも読み取れますが、ウェブは利用できません。

`/kimi:task`、`/kimi:review`、および読み取り専用の`/kimi:swarm`は、2つのフラグを受け付けます。

- `--read-root <absolute-directory>`は、ファイルの読み取りをワークスペースと指定したディレクトリに制限します。複数回指定できます
- `--network`は、ウェブ検索と公開ウェブページの取得を許可します。同時に、ファイルの読み取りをワークスペースと`--read-root`で指定したディレクトリに制限します

書き込みを行うタスクは、これらのフラグを受け付けません。制限は1回の実行にのみ適用されます。`--network`なしで開始したセッションに`--network`を追加するには、`/kimi:task --fresh --network`で新しいセッションを開始してください。

制限は、Kimiが自身のツールで読み取るファイルに適用されます。レビューの差分はリポジトリ全体をカバーし、`AGENTS.md`などのKimi自身の指示ファイルも引き続きモデルに届きます。

## プラグインより先にKimiが更新された場合

このプラグインは、Kimiの各リリースを検証したうえで認定します。お使いのKimiがプラグインの認識しているバージョンより新しい場合、次の動作になります。

- `/kimi:task`、`/kimi:review`、およびレビューゲートは、警告を出しながら引き続き動作します
- `/kimi:task --write`、`/kimi:pursue`、`/kimi:swarm`は`KIMI_CAPABILITY_NOT_CERTIFIED`を返して実行を拒否します
- `--network`は実行を拒否します

すべての機能を引き続き使えるようにするには、`/kimi:setup --install-kimi`（DSHでは`/kimi-setup --install-kimi`）を実行してください。このコマンドは、プラグイン専用として最新の認定済みKimiをインストールし、ユーザー自身の`kimi`には手を加えません。何かをダウンロードするのはこのコマンドだけです。

タスクは、`KIMI_PLUGIN_CC_KIMI_BIN`のパス、プラグインが独自にインストールしたKimi、`PATH`上の`kimi`のうち、最初に見つかったものを使用します。`/kimi:setup --check`は、そのどれが使われるかを`Kimi binary:`の行に表示します。

## 複数のホストを使う場合

使用しているすべてのホストでプラグインを更新し、それぞれでセットアップを実行してください。

各ホストは共有のKimi設定に独自のフックを追加し、Kimiはタスクごとにすべてのフックを実行します。いずれかのホストに古いバージョンのプラグインがある場合、そのフックはすべてのタスクに古いルールを適用し、新しいバージョンで許可されているものをブロックすることがあります。このようなことが起こり得る場合、タスクは警告を出します。

## Kimiでセッションを表示する

プラグインのセッションはKimi Code Desktopと`kimi web`に表示され、`Kimi Ask: …`のようなタイトルと、リクエスト内容のプレビューが付きます。Kimiが生成したタイトルに置き換えることがあります。手動での名前変更は保持されます。[セッションの表示とタイトル](./docs/session-visibility.md)を参照してください。

## モデルを選択する

新しいセッションは、デフォルトのKimiモデルを使用します。別のモデルを使うには、`/kimi:setup --models`でモデル一覧を表示します（Codexでは`$kimi-setup`に一覧表示を依頼してください）。この操作はローカルの一覧を読み取ります。プロバイダーには接続しません。

一覧にあるエイリアスを`-m`で渡します。

```text
/kimi:review -m 'provider/model' Check error handling in this diff.
```

これによって保存済みのデフォルト設定が変わることはありません。デフォルトを変更するには、`kimi`を実行して`/model`を使用してください。[モデルの選択とプロバイダー設定](./docs/models.md)を参照してください。

## タスクを確認またはキャンセルする

| 操作 | Claude Code | Codex | DSH |
| --- | --- | --- | --- |
| 進捗の確認 | `/kimi:status` | `$kimi-status` | `/kimi-status` |
| 結果の読み取り | `/kimi:result` | `$kimi-result` | `/kimi-result` |
| キャンセル | `/kimi:cancel` | `$kimi-cancel` | `/kimi-cancel` |

ジョブIDを指定しない場合、キャンセルはこのリポジトリで実行中の最新タスクを停止します。書き込みスウォームがパッチを保存できるよう、アプリを中断するのではなくキャンセルを使用してください。キャンセルしても、タスクがすでに行った変更は元に戻りません。

中断されたスウォームについては、[スウォームの復旧](./docs/swarm-recovery.md)を参照してください。

## プラグインを更新または削除する

Claude Codeでは、`/plugin`を開き、`kimi-marketplace`を再読み込みして`kimi`を更新します。その後、もう一度`/kimi:setup`を実行してください。

Codexでは、以下のコマンドを実行してから新しいタスクを開き、もう一度`$kimi-setup`を実行します。

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

プラグインを削除するには、まずフックを削除します。Claude Codeでは`/kimi:setup --uninstall`、Codexでは`$kimi-setup`、DSHでは`/kimi-setup --uninstall`を実行してください。他のホストのフックはそのまま残ります。

2.xからアップグレードする場合は、[3.0へのアップグレード](./docs/migration.md#upgrading-to-30)を参照してください。

## セットアップの問題を解決する

フックのチェックに失敗した場合は、表示された診断内容に従い、そのホストでセットアップを実行してください。チェックを回避しないでください。

`KIMI_CAPABILITY_NOT_CERTIFIED`が表示された場合は、`/kimi:setup --install-kimi`を実行するか、プラグインを更新してください。

タスクに警告が表示された場合でも、タスク自体は実行されています。警告には修正すべき内容が示されています。

すべての拒否コードとその対処法は、[拒否コード一覧](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100)に記載されています。

## 安全上の制限を理解する

このプラグインは、自身が開始するKimiセッションについてのみ動作を保証します。ユーザー自身のKimi設定を監視・制限することはありません。

フックがKimiのすべてのツール呼び出しを検査し、タスクに許可されていない操作を拒否します。

- 読み取り専用タスクは、ファイルの書き込みやシェルコマンドの実行ができません
- 書き込みを行うタスクは、ワークスペース内のファイルのみを変更でき、Gitの状態は変更できません
- 書き込みスウォームは、最新コミットから作成した一時的なGitワークツリーで作業し、パッチを返します。パッチの適用はしません

このプラグインは以下のことを行いません。

- `--read-root`または`--network`を渡さない限り、タスクが読み取れる範囲を制限すること
- ウェブアドレスの到達先を確認すること。公開アドレスがプライベートアドレスにリダイレクトされる可能性があります
- サンドボックスとして動作すること。書き込みを行うタスクはテストなどのコマンドを実行でき、それによってリポジトリ内のコードが実行されます
- コミットを行うこと。変更を残す前に内容を確認してください

書き込みを行うタスクは、信頼できるリポジトリでのみ実行してください。

[安全性と制限事項](./docs/safety.md)、[リリース履歴](./CHANGELOG.md)、[今後の予定](./ROADMAP-TO-GA.md)を参照してください。

## コントリビュートする

バグの報告や変更の提案は、[GitHubのIssue](https://github.com/linxule/kimi-plugin-cc/issues)で行ってください。コントリビューターは、[ランタイム不変条件](./docs/invariants.md)と[CIの詳細](./docs/ci.md)を確認できます。

</details>

---

This plugin uses [Kimi Code](https://github.com/MoonshotAI/kimi-code). Its runtime design draws on [OpenAI's codex-plugin-cc](https://github.com/openai/codex-plugin-cc). It is licensed under [Apache-2.0](./LICENSE).
