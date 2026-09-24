# Kimi for Claude Code and Codex

[![Latest release](https://img.shields.io/github/v/release/linxule/kimi-plugin-cc)](https://github.com/linxule/kimi-plugin-cc/releases/latest) [![CI](https://github.com/linxule/kimi-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/kimi-plugin-cc/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Use Kimi to explain code, review changes, challenge a design, or work toward a goal — an independent second opinion from a different model family, inside the Claude Code or Codex session you're already in.

[Latest release](https://github.com/linxule/kimi-plugin-cc/releases/latest) · [Roadmap](./ROADMAP-TO-GA.md) · [Report an issue](https://github.com/linxule/kimi-plugin-cc/issues) · [Apache-2.0 license](./LICENSE)

![Claude Code running /kimi:review on this repository, with Kimi's findings verified claim by claim in the same session](./assets/claude-code-kimi-review.jpg)

*Claude Code runs `/kimi:review` on this repository — Kimi reviews the diff, and the host verifies each claim against the tree.*

![Codex running $kimi-ask to explain this project's entry point](./assets/codex-kimi-ask.jpg)

*Codex runs `$kimi-ask` — a read-only explanation of this project's entry point, from the entry shell script to the command modules.*

Choose a language below. Each guide opens on this page.

选择语言，展开阅读 · Choisissez votre langue · 言語を選んで開いてください

<details open>
<summary>English — Get started</summary>

## Use Kimi in your coding tasks

Ask Kimi to explain code, review changes, challenge a design, or make a focused fix. You can use this plugin in Claude Code or Codex.

The plugin runs the Kimi Code CLI on your computer. It uses your Kimi subscription or a provider you configure in Kimi. Calls count against that subscription or API account. Your Claude Code or Codex login stays unchanged. The selected provider receives the prompts and code needed for your task.

Start with a question or a review. Their tool rules allow reading files and deny file writes and shell commands. Other modes can change files. Read the [safety limits](./docs/safety.md) before asking Kimi to make changes.

## Before you install

You need:

- macOS or Linux
- Claude Code or Codex with plugin support
- Node.js 22.5 or newer
- Kimi Code CLI 2.1.1, the recommended version for plugin 2.0.6

Windows is not currently supported. Check your versions in a terminal:

```sh
node --version
kimi --version
```

Use the [Kimi Code installation guide](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) if you need the CLI. You do not need Bun or a build step to use this plugin.

We test compatibility with exact CLI versions. A newer CLI may need a newer plugin. See [supported versions and upgrades](./docs/migration.md).

Run `kimi` in your terminal. Use `/login` for a Kimi subscription, or `/provider` to set up an API provider. Enter credentials in Kimi, never in the assistant conversation. Exit Kimi when you finish setup. If you set `KIMI_CODE_HOME`, use the same location for Kimi and the plugin.

## Install in Claude Code

Open Claude Code in your project. Enter these commands in Claude Code:

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

Setup installs a hook that checks Kimi's tool calls against the plugin's rules. The `Probe:` line should show `ok`. If it fails, follow the setup guidance below.

Try a question that does not change files:

```text
/kimi:ask Explain how this project's main entry point works.
```

## Install in Codex

Run these commands in your terminal:

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Open a new Codex task in your project. Ask it to set up the plugin:

```text
Use $kimi-setup to install the safety hook, then check readiness.
```

The hook checks Kimi's tool calls against the plugin's rules. The `Probe:` line should show `ok`. If it fails, follow the setup guidance below. Then try:

```text
Use $kimi-ask to explain how this project's main entry point works.
```

If you use both Claude Code and Codex, run setup in each. Each app has its own hook in the shared Kimi configuration.

## Choose a task

| Task | Claude Code command | Codex skill | File access |
| --- | --- | --- | --- |
| Explain code | `/kimi:ask` | `$kimi-ask` | Read-only |
| Review code changes | `/kimi:review` | `$kimi-review` | Read-only |
| Challenge a design or approach | `/kimi:challenge` | `$kimi-challenge` | Read-only |
| Make a focused fix | `/kimi:rescue` | `$kimi-rescue` | Can edit your project |
| Review several areas at once | `/kimi:swarm` | `$kimi-swarm` | Read-only |
| Prepare edits in parallel | `/kimi:swarm --write` | `$kimi-swarm-write` | Only in a temporary Git worktree; returns a patch for you to apply |
| Work toward a goal over several turns | `/kimi:pursue` | `$kimi-pursue` | Can edit your project; experimental |

Review and challenge inspect your Git diff. Use ask for general questions about your repository.

Pursue and swarm have time limits. Swarm runs tasks in parallel, so it can use more tokens than a single task.

Claude Code also has an optional [review gate](./commands/setup.md). It checks work when Claude finishes a turn and is off by default.

## View sessions in Kimi

Plugin sessions use the shared Kimi Code Desktop and `kimi web` history. New native-v2 sessions receive a readable fallback title that Kimi can replace with a generated title. Manual renames are preserved. For missing older sessions and the native **Gen Title** action, see [session visibility and titles](./docs/session-visibility.md).

## Choose a model

New Kimi sessions use your configured default model. You only need to choose a model if you want a different one.

In Claude Code, run `/kimi:setup --models`. In Codex, ask `$kimi-setup` to list configured models. This reads your local model list. It does not contact providers or test credentials. A listed model can still fail because of authentication, access, or tool support.

Copy a model alias from the list. Replace `provider/model` with that alias:

```text
/kimi:review -m 'provider/model' Check error handling in this diff.
```

In Codex, ask “Use $kimi-review with my configured model named …”. Both apps support model requests in plain language. If several models match, the assistant asks you to choose. It does not guess model IDs or switch models silently after an error.

To test a listed model, run a small task with its alias. This makes a provider call under your account.

A choice for one task does not change your saved default. To change that default, run `kimi` and use `/model`.

Resumed sessions keep their previous model unless you pass `-m` with a different alias. For swarm, `-m` selects the coordinator's model. Workers may use different models from Kimi's secondary-model settings. See [model selection and provider setup](./docs/models.md).

## Check or cancel a task

Use these commands to follow a task:

| Action | Claude Code command | Codex skill |
| --- | --- | --- |
| Check progress | `/kimi:status` | `$kimi-status` |
| Read the result | `/kimi:result` | `$kimi-result` |
| Cancel work | `/kimi:cancel` | `$kimi-cancel` |

Without a job ID, cancel stops the latest running task for this repository. If several tasks are running, check which one you want to stop first. Use cancel rather than interrupting the app so write-swarm can save its patch.

Canceling a task does not undo changes it has already made.

Ask and rescue support resuming a session. For example, `/kimi:ask -r Explain the next step.` continues your latest ask session. In Codex, ask `$kimi-ask` to resume it. See the [ask options](./commands/ask.md) and [rescue options](./commands/rescue.md).

## Update or remove the plugin

### Update in Claude Code

Open `/plugin`, refresh `kimi-marketplace`, and update `kimi`. Run `/kimi:setup` again to update the hook's installation path.

### Update in Codex

Run these commands in your terminal:

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

Open a new task and run `$kimi-setup` again.

### Remove the plugin

Remove the app's hook before removing its plugin. In Claude Code, run `/kimi:setup --uninstall`. In Codex, ask `$kimi-setup` to uninstall the hook. This leaves the other app's hook in place.

## Fix setup problems

If a hook check fails, follow its diagnosis. Run setup for the affected app when instructed. Do not bypass the check.

If you see `KIMI_CAPABILITY_NOT_CERTIFIED`, update the plugin or use a certified CLI version. Running setup again does not certify a new CLI.

If you see `CLI_V2_PLAN_MODE_CONFIGURED`, set `default_plan_mode` to `false` or remove it from your Kimi `config.toml` file. Sessions run by this plugin cannot use plan mode.

All refusal codes and their remedies are listed in the [refusal-code catalog](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100).

## Understand the safety limits

The tool rules for ask, review, challenge, and read-only swarm deny file writes and shell commands. Rescue and pursue can write files in your workspace. Swarm with `--write` works in a temporary Git worktree. It starts from your latest commit, so it does not include uncommitted changes. It returns a patch without applying it to your project.

The plugin does not commit changes. Review changes before you keep or apply them.

Only use tasks that can write files in repositories you trust. Rescue, pursue, and swarm with `--write` can run tests and similar commands. These commands execute code from your repository. The hook restricts tool use; it is not an operating-system sandbox.

See [safety and limitations](./docs/safety.md), [release history](./CHANGELOG.md), and [planned work](./ROADMAP-TO-GA.md).

## Contribute

Start with the [contribution guide](./CONTRIBUTING.md). The [runtime overview](./runtime/README.md) and [project contracts](./AGENTS.md) explain the implementation.

Every release is cross-reviewed by the agents this plugin orchestrates — Kimi, Claude, and Codex review each other's work on this repository, a practice documented across the [changelog](./CHANGELOG.md).

Contributors need Bun to run `bun run check`. The detailed engineering documents are in English.

</details>

<details>
<summary>简体中文 — 开始使用</summary>

## 用 Kimi 辅助编程

你可以让 Kimi 解释代码、审查修改、指出设计中的问题，或完成一项范围明确的修复。本插件支持 Claude Code 和 Codex。

插件在你的电脑上调用 Kimi Code CLI，使用你的 Kimi 订阅或在 Kimi 中配置的服务商。调用会消耗相应的订阅额度或产生 API 费用。Claude Code 和 Codex 的登录状态不变。任务所需的提示词和代码会发送给所选服务商。

建议先尝试提问或代码审查。这两类任务允许读取文件，禁止写入文件和执行 shell 命令。其他模式可以修改文件。让 Kimi 动手修改前，请先了解[安全限制](./docs/safety.md)。

## 安装前准备

你需要：

- macOS 或 Linux
- 支持插件的 Claude Code 或 Codex
- Node.js 22.5 或更高版本
- Kimi Code CLI 2.1.1，这是插件 2.0.6 的推荐版本

目前不支持 Windows。在终端检查版本：

```sh
node --version
kimi --version
```

如果尚未安装 CLI，请参照 [Kimi Code 安装指南](https://www.kimi.com/code/docs/zh/kimi-code-cli/getting-started)。使用本插件不需要 Bun，也不需要编译。

我们按具体 CLI 版本验证兼容性。升级 CLI 后，可能也需要更新插件。参见[支持的版本与升级说明](./docs/migration.md)。

在终端运行 `kimi`。Kimi 订阅用户通过 `/login` 登录；使用 API 的用户通过 `/provider` 配置服务商。请在 Kimi 中输入凭据，不要发到助手对话中。配置完成后退出 Kimi。如果设置了 `KIMI_CODE_HOME`，请确保 Kimi 和插件使用同一路径。

## 在 Claude Code 中安装

在项目目录中启动 Claude Code，然后在 Claude Code 中输入：

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

Setup 会安装一个钩子，按插件规则检查 Kimi 的工具调用。检查结果中，`Probe:` 一行应显示 `ok`。如果失败，请参照下方的安装问题处理说明。

试着问一个不需要修改文件的问题：

```text
/kimi:ask 解释这个项目的主入口如何工作。
```

## 在 Codex 中安装

在终端运行：

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

在项目中打开一个新的 Codex 任务，请它完成配置：

```text
使用 $kimi-setup 安装安全钩子，然后检查配置是否可用。
```

钩子会按插件规则检查 Kimi 的工具调用。检查结果中，`Probe:` 一行应显示 `ok`。如果失败，请参照下方的安装问题处理说明。然后试着输入：

```text
使用 $kimi-ask 解释这个项目的主入口如何工作。
```

如果同时使用 Claude Code 和 Codex，请分别运行 setup。两个应用各有自己的钩子，共用一份 Kimi 配置。

## 选择任务

| 任务 | Claude Code 命令 | Codex 技能 | 文件操作范围 |
| --- | --- | --- | --- |
| 解释代码 | `/kimi:ask` | `$kimi-ask` | 只读 |
| 审查代码修改 | `/kimi:review` | `$kimi-review` | 只读 |
| 检查设计或方案中的问题 | `/kimi:challenge` | `$kimi-challenge` | 只读 |
| 完成一项范围明确的修复 | `/kimi:rescue` | `$kimi-rescue` | 可以修改项目文件 |
| 同时审查多个部分 | `/kimi:swarm` | `$kimi-swarm` | 只读 |
| 并行准备修改 | `/kimi:swarm --write` | `$kimi-swarm-write` | 只在临时 Git 工作树中修改，返回补丁，由你决定是否应用 |
| 通过多轮任务推进目标 | `/kimi:pursue` | `$kimi-pursue` | 可以修改项目文件，属于实验性功能 |

Review 和 challenge 检查 Git 差异。关于仓库的一般问题，使用 ask。

Pursue 和 swarm 都有运行时限。Swarm 并行执行多个任务，可能比单个任务消耗更多 token。

Claude Code 还提供可选的[自动审查功能](./commands/setup.md)，在 Claude 完成一轮回复时检查工作，默认关闭。

## 选择模型

新的 Kimi 会话使用已配置的默认模型。只有想换用其他模型时，才需要指定模型。

在 Claude Code 中运行 `/kimi:setup --models`。在 Codex 中，请 `$kimi-setup` 列出已配置的模型。这只会读取本地列表，不会连接服务商或验证凭据。列表中的模型仍可能因认证、访问权限或工具支持问题而无法使用。

从列表中复制模型别名，替换下方的 `provider/model`：

```text
/kimi:review -m 'provider/model' 检查这次修改中的错误处理。
```

在 Codex 中，可以说“使用 $kimi-review，选择我已配置的名为……的模型”。两个应用都支持用自然语言指定模型。如果有多个匹配项，助手会请你选择。它不会猜测模型 ID，也不会在出错后悄悄换用其他模型。

要测试某个模型，请用它的别名运行一个小任务。这会通过你的账户调用服务商。

为单次任务选择模型不会更改已保存的默认设置。要更改默认模型，请运行 `kimi`，使用 `/model`。

恢复会话时会沿用之前的模型，除非通过 `-m` 指定另一个别名。对于 swarm，`-m` 选择负责协调的智能体所用的模型。执行子任务的智能体可能使用 Kimi 的辅助模型（secondary model）设置中的其他模型。参见[模型选择与服务商配置](./docs/models.md)。

## 查看或取消任务

你可以用以下命令跟进任务：

| 操作 | Claude Code 命令 | Codex 技能 |
| --- | --- | --- |
| 查看进度 | `/kimi:status` | `$kimi-status` |
| 查看结果 | `/kimi:result` | `$kimi-result` |
| 取消任务 | `/kimi:cancel` | `$kimi-cancel` |

不提供任务 ID 时，cancel 会停止当前仓库中最近启动且仍在运行的任务。如果有多个任务在运行，请先确认要停止哪一个。请使用 cancel，不要直接中断应用，以便 write-swarm 保存补丁。

取消任务不会撤销已经完成的修改。

Ask 和 rescue 支持恢复会话。例如，`/kimi:ask -r 解释下一步。` 会继续最近一次 ask 会话。在 Codex 中，请 `$kimi-ask` 恢复该会话。参见 [ask 参数](./commands/ask.md)和 [rescue 参数](./commands/rescue.md)。

## 更新或移除插件

### 在 Claude Code 中更新

打开 `/plugin`，刷新 `kimi-marketplace`，然后更新 `kimi`。再次运行 `/kimi:setup`，更新钩子的安装路径。

### 在 Codex 中更新

在终端运行：

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

打开一个新任务，再次运行 `$kimi-setup`。

### 移除插件

先移除该应用的钩子，再移除插件。在 Claude Code 中运行 `/kimi:setup --uninstall`。在 Codex 中，请 `$kimi-setup` 卸载钩子。这不会移除另一个应用的钩子。

## 处理安装问题

如果钩子检查失败，请按诊断信息处理。提示需要重新配置时，在对应应用中运行 setup。不要绕过检查。

如果出现 `KIMI_CAPABILITY_NOT_CERTIFIED`，请更新插件，或改用已验证兼容的 CLI 版本。再次运行 setup 不能让新的 CLI 版本自动通过兼容性验证。

如果出现 `CLI_V2_PLAN_MODE_CONFIGURED`，请将 Kimi 的 `config.toml` 文件中的 `default_plan_mode` 设为 `false`，或删除该项。本插件运行的会话不能使用计划模式。

所有拒绝码及其处理方法见[拒绝码目录](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100)。

## 了解安全限制

Ask、review、challenge 和只读 swarm 的工具规则禁止写入文件和执行 shell 命令。Rescue 和 pursue 可以修改工作区内的文件。带 `--write` 的 swarm 在临时 Git 工作树中操作。它从最新提交开始，不包含尚未提交的修改。任务结束后返回补丁，不会自动应用到项目。

插件不会提交修改。保留或应用修改前，请先审查。

只在你信任的仓库中运行能修改文件的任务。Rescue、pursue 和带 `--write` 的 swarm 可以运行测试等命令。这些命令会执行仓库中的代码。钩子限制的是工具调用，它不是操作系统沙箱。

参见[安全与限制](./docs/safety.md)、[版本记录](./CHANGELOG.md)和[后续计划](./ROADMAP-TO-GA.md)。

## 参与开发

请先阅读[贡献指南](./CONTRIBUTING.md)。[运行时说明](./runtime/README.md)和[项目约定](./AGENTS.md)介绍了实现方式。

每个版本都经过本插件所编排智能体的交叉审查——Kimi、Claude 与 Codex 互相审查彼此在本仓库中的工作，这一实践贯穿整个[版本记录](./CHANGELOG.md)。

开发者需要使用 Bun 运行 `bun run check`。详细技术文档目前使用英文。

</details>

<details>
<summary>Français — Bien démarrer</summary>

## Utiliser Kimi pour vos tâches de développement

Demandez à Kimi d'expliquer du code, de faire une revue de code, de remettre en question une approche ou de corriger un problème précis. Ce plugin fonctionne dans Claude Code et Codex.

Le plugin exécute Kimi Code CLI sur votre ordinateur. Il utilise votre abonnement Kimi ou un fournisseur configuré dans Kimi. Les appels consomment votre quota d'abonnement ou sont facturés sur votre compte API. Votre connexion à Claude Code ou à Codex ne change pas. Le fournisseur choisi reçoit les prompts et le code nécessaires à la tâche.

Commencez par une question ou une revue de code. Ces modes autorisent la lecture des fichiers, mais interdisent leur modification et l'exécution de commandes shell. D'autres modes peuvent modifier des fichiers. Consultez les [limites de sécurité](./docs/safety.md) avant de demander des modifications à Kimi.

## Préparer l'installation

Il vous faut :

- macOS ou Linux
- une version de Claude Code ou de Codex prenant en charge les plugins
- Node.js 22.5 ou une version ultérieure
- Kimi Code CLI 2.1.1, la version recommandée pour le plugin 2.0.6

Windows n'est pas pris en charge actuellement. Vérifiez les versions dans un terminal :

```sh
node --version
kimi --version
```

Si le CLI n'est pas installé, suivez le [guide d'installation de Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started) (en anglais). Vous n'avez pas besoin de Bun ni d'étape de compilation pour utiliser ce plugin.

Nous vérifions la compatibilité pour chaque version précise du CLI. Une nouvelle version du CLI peut nécessiter une mise à jour du plugin. Consultez les [versions prises en charge et les consignes de mise à jour](./docs/migration.md).

Lancez `kimi` dans un terminal. Utilisez `/login` pour un abonnement Kimi ou `/provider` pour configurer un fournisseur d'API. Saisissez vos identifiants dans Kimi, jamais dans la conversation avec l'assistant. Quittez Kimi une fois la configuration terminée. Si vous définissez `KIMI_CODE_HOME`, utilisez le même emplacement pour Kimi et le plugin.

## Installer dans Claude Code

Ouvrez Claude Code dans votre projet. Saisissez ces commandes dans Claude Code :

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

Setup installe un hook qui vérifie les appels d'outils de Kimi selon les règles du plugin. La ligne `Probe:` doit afficher `ok`. En cas d'échec, consultez les consignes de dépannage ci-dessous.

Essayez une question qui ne modifie aucun fichier :

```text
/kimi:ask Explique le fonctionnement du point d'entrée principal de ce projet.
```

## Installer dans Codex

Exécutez ces commandes dans un terminal :

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

Ouvrez une nouvelle tâche Codex dans votre projet. Demandez-lui de configurer le plugin :

```text
Utilise $kimi-setup pour installer le hook de sécurité, puis vérifie que tout est prêt.
```

Le hook vérifie les appels d'outils de Kimi selon les règles du plugin. La ligne `Probe:` doit afficher `ok`. En cas d'échec, consultez les consignes de dépannage ci-dessous. Essayez ensuite :

```text
Utilise $kimi-ask pour expliquer le fonctionnement du point d'entrée principal de ce projet.
```

Si vous utilisez Claude Code et Codex, lancez setup dans chaque application. Chacune possède son propre hook dans la configuration Kimi commune.

## Choisir une tâche

| Tâche | Commande Claude Code | Skill Codex | Accès aux fichiers |
| --- | --- | --- | --- |
| Expliquer du code | `/kimi:ask` | `$kimi-ask` | Lecture seule |
| Faire une revue des modifications | `/kimi:review` | `$kimi-review` | Lecture seule |
| Remettre en question une conception ou une approche | `/kimi:challenge` | `$kimi-challenge` | Lecture seule |
| Corriger un problème précis | `/kimi:rescue` | `$kimi-rescue` | Peut modifier votre projet |
| Examiner plusieurs parties à la fois | `/kimi:swarm` | `$kimi-swarm` | Lecture seule |
| Préparer des modifications en parallèle | `/kimi:swarm --write` | `$kimi-swarm-write` | Uniquement dans un worktree Git temporaire ; renvoie un patch que vous pouvez appliquer |
| Poursuivre un objectif sur plusieurs tours | `/kimi:pursue` | `$kimi-pursue` | Peut modifier votre projet ; fonction expérimentale |

Review et challenge examinent votre diff Git. Utilisez ask pour les questions générales sur votre dépôt.

Pursue et swarm ont une durée limitée. Swarm exécute des tâches en parallèle et peut donc consommer plus de tokens qu'une tâche seule.

Claude Code propose aussi une [revue automatique facultative](./commands/setup.md). Elle vérifie le travail lorsque Claude termine un tour et reste désactivée par défaut.

## Choisir un modèle

Les nouvelles sessions Kimi utilisent le modèle configuré par défaut. Précisez un modèle uniquement si vous souhaitez en utiliser un autre que celui par défaut.

Dans Claude Code, lancez `/kimi:setup --models`. Dans Codex, demandez à `$kimi-setup` de lister les modèles configurés. Cette opération lit la liste locale sans contacter les fournisseurs ni vérifier les identifiants. Un modèle de la liste peut échouer faute d'authentification, d'accès ou de prise en charge des outils.

Copiez un alias de modèle depuis la liste. Remplacez `provider/model` par cet alias :

```text
/kimi:review -m 'provider/model' Vérifie la gestion des erreurs dans ces modifications.
```

Dans Codex, demandez : « Utilise $kimi-review avec mon modèle configuré nommé… ». Les deux applications acceptent les demandes de modèle en langage naturel. Si plusieurs modèles correspondent, l'assistant vous demande de choisir. Il ne devine pas les identifiants de modèle et ne change pas de modèle sans vous le dire après une erreur.

Pour tester un modèle de la liste, lancez une petite tâche avec son alias. Cela effectue un appel au fournisseur avec votre compte.

Le choix d'un modèle pour une tâche ne change pas votre modèle par défaut. Pour modifier ce dernier, lancez `kimi` et utilisez `/model`.

Une session reprise conserve son modèle, sauf si vous passez un autre alias avec `-m`. Pour swarm, `-m` choisit le modèle du coordinateur. Les agents chargés des sous-tâches peuvent utiliser d'autres modèles définis dans les paramètres de modèles secondaires de Kimi. Consultez le [choix des modèles et la configuration des fournisseurs](./docs/models.md).

## Suivre ou annuler une tâche

Utilisez ces commandes pour suivre une tâche :

| Action | Commande Claude Code | Skill Codex |
| --- | --- | --- |
| Voir la progression | `/kimi:status` | `$kimi-status` |
| Afficher le résultat | `/kimi:result` | `$kimi-result` |
| Annuler la tâche | `/kimi:cancel` | `$kimi-cancel` |

Sans identifiant de tâche, cancel arrête la dernière tâche lancée qui est encore active dans ce dépôt. Si plusieurs tâches sont en cours, vérifiez d'abord celle que vous souhaitez arrêter. Utilisez cancel au lieu d'interrompre l'application pour laisser write-swarm enregistrer son patch.

Annuler une tâche n'annule pas les modifications déjà effectuées.

Ask et rescue permettent de reprendre une session. Par exemple, `/kimi:ask -r Explique l'étape suivante.` reprend votre dernière session ask. Dans Codex, demandez à `$kimi-ask` de la reprendre. Consultez les [options d'ask](./commands/ask.md) et les [options de rescue](./commands/rescue.md).

## Mettre à jour ou supprimer le plugin

### Mettre à jour dans Claude Code

Ouvrez `/plugin`, actualisez `kimi-marketplace` et mettez `kimi` à jour. Relancez `/kimi:setup` pour mettre à jour le chemin d'installation du hook.

### Mettre à jour dans Codex

Exécutez ces commandes dans un terminal :

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

Ouvrez une nouvelle tâche et relancez `$kimi-setup`.

### Supprimer le plugin

Supprimez le hook de l'application avant d'en retirer le plugin. Dans Claude Code, lancez `/kimi:setup --uninstall`. Dans Codex, demandez à `$kimi-setup` de désinstaller le hook. Celui de l'autre application reste en place.

## Résoudre les problèmes d'installation

Si la vérification du hook échoue, suivez le diagnostic. Relancez setup dans l'application concernée lorsque les instructions le demandent. Ne contournez pas la vérification.

Si vous voyez `KIMI_CAPABILITY_NOT_CERTIFIED`, mettez à jour le plugin ou utilisez une version du CLI dont la compatibilité a été vérifiée. Relancer setup ne valide pas la compatibilité d'une nouvelle version du CLI.

Si vous voyez `CLI_V2_PLAN_MODE_CONFIGURED`, réglez `default_plan_mode` sur `false` ou supprimez cette option du fichier `config.toml` de Kimi. Les sessions lancées par ce plugin ne peuvent pas utiliser le mode plan.

Tous les codes de refus et leurs remèdes sont répertoriés dans le [catalogue des codes de refus](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100).

## Comprendre les limites de sécurité

Les règles des modes ask, review, challenge et swarm en lecture seule interdisent les écritures et les commandes shell. Rescue et pursue peuvent modifier les fichiers de votre espace de travail. Swarm avec `--write` travaille dans un worktree Git temporaire. Il part du dernier commit et n'inclut donc pas les modifications non commitées. Il renvoie un patch sans l'appliquer à votre projet.

Le plugin ne crée aucun commit. Examinez les modifications avant de les conserver ou de les appliquer.

N'utilisez les tâches pouvant écrire des fichiers que dans des dépôts auxquels vous faites confiance. Rescue, pursue et swarm avec `--write` peuvent lancer des tests et des commandes similaires. Ces commandes exécutent du code du dépôt. Le hook limite l'utilisation des outils ; ce n'est pas un bac à sable du système d'exploitation.

Consultez les [limites de sécurité](./docs/safety.md), l'[historique des versions](./CHANGELOG.md) et les [travaux prévus](./ROADMAP-TO-GA.md).

## Contribuer

Commencez par le [guide de contribution](./CONTRIBUTING.md). La [présentation du runtime](./runtime/README.md) et les [règles du projet](./AGENTS.md) expliquent l'implémentation.

Chaque version fait l'objet d'une relecture croisée par les agents que ce plugin orchestre — Kimi, Claude et Codex révisent mutuellement leur travail sur ce dépôt, une pratique documentée dans l'ensemble du [journal des versions](./CHANGELOG.md).

Les contributeurs ont besoin de Bun pour exécuter `bun run check`. La documentation technique détaillée est en anglais.

</details>

<details>
<summary>日本語 — はじめに</summary>

## Kimi を開発に使う

コードの説明、変更のレビュー、設計の問題点の指摘、範囲を絞った修正を Kimi に依頼できます。このプラグインは Claude Code と Codex で使えます。

プラグインは、お使いのコンピューターで Kimi Code CLI を実行します。Kimi のサブスクリプション、または Kimi に設定したプロバイダーを利用します。呼び出しは、そのサブスクリプションの利用枠を消費するか、API アカウントに課金されます。Claude Code や Codex のログイン状態は変わりません。タスクに必要なプロンプトとコードは、選択したプロバイダーに送信されます。

まずは質問かコードレビューを試してください。これらのモードではファイルの読み取りを許可し、書き込みとシェルコマンドの実行を禁止しています。ほかのモードではファイルを変更できます。変更を依頼する前に、[安全上の制限](./docs/safety.md)を確認してください。

## インストール前の準備

次の環境が必要です。

- macOS または Linux
- プラグインに対応した Claude Code または Codex
- Node.js 22.5 以降
- Kimi Code CLI 2.1.1（プラグイン 2.0.6 の推奨バージョン）

現在、Windows には対応していません。ターミナルでバージョンを確認します。

```sh
node --version
kimi --version
```

CLI が未インストールの場合は、[Kimi Code のインストールガイド（英語）](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started)を参照してください。プラグインを使うために Bun やビルド作業は必要ありません。

互換性は CLI のバージョンごとに検証しています。CLI を更新すると、プラグインの更新も必要になる場合があります。[対応バージョンと更新手順](./docs/migration.md)を参照してください。

ターミナルで `kimi` を実行します。Kimi のサブスクリプションを使う場合は `/login`、API プロバイダーを設定する場合は `/provider` を使います。認証情報は Kimi に入力し、アシスタントとの会話には送らないでください。設定が終わったら Kimi を終了します。`KIMI_CODE_HOME` を設定している場合は、Kimi とプラグインで同じ場所を使ってください。

## Claude Code にインストールする

プロジェクトで Claude Code を開き、Claude Code 内で次のコマンドを入力します。

```text
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:setup --check
```

Setup は、Kimi のツール呼び出しをプラグインのルールに照らして確認するフックをインストールします。正常であれば `Probe:` 行に `ok` と表示されます。失敗した場合は、後述の「設定の問題を解決する」を参照してください。

ファイルを変更しない質問を試します。

```text
/kimi:ask このプロジェクトのメインのエントリーポイントがどう動くか説明してください。
```

## Codex にインストールする

ターミナルで次のコマンドを実行します。

```sh
codex plugin marketplace add linxule/kimi-plugin-cc
codex plugin add kimi@kimi-marketplace
```

プロジェクトで Codex の新しいタスクを開き、設定を依頼します。

```text
$kimi-setup を使って安全フックをインストールし、設定を確認してください。
```

フックは Kimi のツール呼び出しをプラグインのルールに照らして確認します。正常であれば `Probe:` 行に `ok` と表示されます。失敗した場合は、後述の「設定の問題を解決する」を参照してください。続いて、次の依頼を試します。

```text
$kimi-ask を使って、このプロジェクトのメインのエントリーポイントがどう動くか説明してください。
```

Claude Code と Codex の両方を使う場合は、それぞれで setup を実行します。共通の Kimi 設定内に、各アプリ専用のフックが作られます。

## タスクを選ぶ

| タスク | Claude Code コマンド | Codex スキル | ファイル操作の範囲 |
| --- | --- | --- | --- |
| コードを説明する | `/kimi:ask` | `$kimi-ask` | 読み取り専用 |
| コードの変更をレビューする | `/kimi:review` | `$kimi-review` | 読み取り専用 |
| 設計や方針の問題点を検討する | `/kimi:challenge` | `$kimi-challenge` | 読み取り専用 |
| 範囲を絞って修正する | `/kimi:rescue` | `$kimi-rescue` | プロジェクトのファイルを変更可能 |
| 複数の箇所を同時にレビューする | `/kimi:swarm` | `$kimi-swarm` | 読み取り専用 |
| 複数の変更を並行して準備する | `/kimi:swarm --write` | `$kimi-swarm-write` | 一時的な Git ワークツリー内のみ変更し、適用用のパッチを返す |
| 複数ターンにわたって目標に取り組む | `/kimi:pursue` | `$kimi-pursue` | プロジェクトのファイルを変更可能（実験的機能） |

Review と challenge は Git の差分を確認します。リポジトリ全般に関する質問には ask を使ってください。

Pursue と swarm には実行時間の上限があります。Swarm はタスクを並行して実行するため、単一のタスクよりトークンを多く消費する場合があります。

Claude Code には、任意で有効にできる[自動レビュー機能](./commands/setup.md)もあります。Claude が応答を終えると作業内容を確認します。初期状態では無効です。

## モデルを選ぶ

新しい Kimi セッションでは、設定済みのデフォルトモデルを使います。別のモデルを使いたい場合だけ指定してください。

Claude Code では `/kimi:setup --models` を実行します。Codex では `$kimi-setup` に設定済みモデルの一覧表示を依頼します。この操作はローカルの一覧を読み取るだけで、プロバイダーへの接続や認証情報の検証は行いません。一覧にあるモデルでも、認証、アクセス権、ツール対応の問題で使えない場合があります。

一覧からモデルのエイリアスをコピーし、次の `provider/model` と置き換えます。

```text
/kimi:review -m 'provider/model' この差分のエラー処理を確認してください。
```

Codex では「$kimi-review を使い、設定済みの『……』というモデルでレビューしてください」と依頼できます。どちらのアプリでも、自然言語でモデルを指定できます。複数のモデルが該当する場合は、アシスタントが選択を求めます。モデル ID を推測したり、エラーの後に黙って別のモデルに切り替えたりはしません。

一覧のモデルを試すには、そのエイリアスで小さなタスクを実行します。あなたのアカウントでプロバイダーへの呼び出しが発生します。

タスクごとにモデルを指定しても、保存済みのデフォルト設定は変わりません。デフォルトモデルを変更するには、`kimi` を実行して `/model` を使います。

再開したセッションは、`-m` で別のエイリアスを指定しない限り、以前のモデルを使います。Swarm の `-m` は調整役のエージェントが使うモデルを指定します。子タスクを担当するエージェントは、Kimi のセカンダリモデル設定に基づく別のモデルを使う場合があります。[モデルの選択とプロバイダーの設定](./docs/models.md)を参照してください。

## 進捗の確認とタスクのキャンセル

次のコマンドでタスクを確認できます。

| 操作 | Claude Code コマンド | Codex スキル |
| --- | --- | --- |
| 進捗を確認する | `/kimi:status` | `$kimi-status` |
| 結果を確認する | `/kimi:result` | `$kimi-result` |
| タスクをキャンセルする | `/kimi:cancel` | `$kimi-cancel` |

タスク ID を指定しない場合、cancel はこのリポジトリで実行中のタスクのうち、最後に開始したものを停止します。複数のタスクが動いている場合は、停止する対象を先に確認してください。write-swarm がパッチを保存できるよう、アプリを強制中断せずに cancel を使ってください。

タスクをキャンセルしても、すでに行われた変更は元に戻りません。

Ask と rescue はセッションの再開に対応しています。たとえば `/kimi:ask -r 次の手順を説明してください。` は、直近の ask セッションを続けます。Codex では `$kimi-ask` に再開を依頼してください。[ask のオプション](./commands/ask.md)と [rescue のオプション](./commands/rescue.md)を参照できます。

## プラグインを更新または削除する

### Claude Code で更新する

`/plugin` を開き、`kimi-marketplace` の情報を更新してから `kimi` を更新します。`/kimi:setup` を再実行して、フックのインストール先を更新してください。

### Codex で更新する

ターミナルで次のコマンドを実行します。

```sh
codex plugin marketplace upgrade kimi-marketplace
codex plugin add kimi@kimi-marketplace
```

新しいタスクを開いて `$kimi-setup` を再実行します。

### プラグインを削除する

プラグインを削除する前に、そのアプリのフックを削除します。Claude Code では `/kimi:setup --uninstall` を実行します。Codex では `$kimi-setup` にフックのアンインストールを依頼してください。もう一方のアプリのフックは残ります。

## 設定の問題を解決する

フックの確認に失敗した場合は、診断結果に従って対処してください。Setup の実行を指示された場合は、該当するアプリで実行します。確認を回避しないでください。

`KIMI_CAPABILITY_NOT_CERTIFIED` が表示されたら、プラグインを更新するか、互換性を検証済みの CLI バージョンを使ってください。Setup を再実行しても、新しい CLI の互換性が検証済みになるわけではありません。

`CLI_V2_PLAN_MODE_CONFIGURED` が表示されたら、Kimi の `config.toml` で `default_plan_mode` を `false` にするか、その項目を削除してください。このプラグインが実行するセッションではプランモードを使えません。

すべての拒否コードと対処方法は、[拒否コードの一覧](./docs/safety.md#refusal-codes-of-the-native-v2-contract-v1100)にまとめています。

## 安全上の制限を理解する

Ask、review、challenge、読み取り専用 swarm のツールルールでは、ファイルへの書き込みとシェルコマンドを禁止しています。Rescue と pursue はワークスペース内のファイルを変更できます。`--write` を指定した swarm は、一時的な Git ワークツリーで作業します。最新のコミットから開始するため、未コミットの変更は含まれません。パッチを返すだけで、プロジェクトには自動適用しません。

プラグインは変更をコミットしません。変更を残す、または適用する前に内容を確認してください。

ファイルを書き換えるタスクは、信頼できるリポジトリでのみ実行してください。Rescue、pursue、`--write` 付きの swarm は、テストなどのコマンドを実行できます。これらのコマンドはリポジトリ内のコードを実行します。フックはツールの使用を制限しますが、OS のサンドボックスではありません。

[安全上の制限](./docs/safety.md)、[リリース履歴](./CHANGELOG.md)、[今後の予定](./ROADMAP-TO-GA.md)も参照してください。

## 開発に参加する

まず[開発への参加ガイド](./CONTRIBUTING.md)を参照してください。[ランタイムの概要](./runtime/README.md)と[プロジェクトの規約](./AGENTS.md)に実装の説明があります。

各リリースは、このプラグインがオーケストレーションするエージェント同士の相互レビューを経ています。Kimi、Claude、Codex がこのリポジトリで互いの作業をレビューしており、その実践は[リリース履歴](./CHANGELOG.md)全体に記録されています。

開発時の `bun run check` には Bun が必要です。詳しい技術文書は英語で提供しています。

</details>

---

This plugin uses [Kimi Code](https://github.com/MoonshotAI/kimi-code). Its runtime design draws on [OpenAI's codex-plugin-cc](https://github.com/openai/codex-plugin-cc). It is licensed under [Apache-2.0](./LICENSE).
