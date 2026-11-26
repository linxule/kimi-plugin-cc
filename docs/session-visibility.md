# Session visibility and native titles

Plugin sessions live in Kimi Code's local session store and appear in both Kimi Code Desktop and `kimi web`.

After a native-v2 run finishes, the plugin writes the run's raw request to the session preview (`lastPrompt`) and marks the shared index dirty. The preview shows your question for `ask`, your task for `rescue`, and your objective for `pursue`, `swarm`, or `swarm_patch`. For `review` and `challenge`, it shows `Review target: <target>`, followed by `. Focus: <text>` when you supply a focus. The preview never contains the plugin's internal prompt prefix, the model's answer, or a trailing `<referenced_sessions>` block.

The plugin redacts credential patterns from the preview and caps it at 4,000 characters. This sync runs on both fresh and resumed sessions, updates any differing preview, and never writes an empty string. Because `kimi -p` never updates `lastPrompt` itself, Desktop and Web would show a blank preview without this step.

One timing race remains if you continue the same session in Desktop while a plugin run finishes. If your Desktop turn finishes before the plugin writes its metadata sync, the plugin overwrites that turn's preview. The preview is local display metadata and never alters model prompts.

## Native generated titles

New native-v2 sessions start with a fallback title such as `Kimi Ask: ...`, `Kimi Rescue: ...`, or `Kimi Review: ...`. The prefix names the operation rather than the calling host. The plugin marks the fallback replaceable (`titleKind: "replaceable"` and `isCustomTitle: false`) so Kimi's native title generator can replace it later. Existing manual titles and previously generated titles stay unchanged.

In Kimi Code Desktop, open the session's Rename menu and select Gen Title to generate a title from the conversation. Desktop also generates a title automatically after an eligible interactive turn finishes. Opening an already completed plugin session in Desktop does not trigger title generation on its own.

The plugin never calls Kimi's native title-generation endpoint automatically. That endpoint resumes the agent, starts background services, and fires session hooks rather than updating metadata alone. By skipping it, the plugin makes no extra provider calls and never reads OAuth credentials.

## Repair existing sessions

Run session repair while your target Kimi sessions are idle. Call `kimi_setup` with `action: "repair_sessions"` from any host (`apply: false` previews changes; add `apply: true` to write and `all: true` for all repositories). You can also run repair from your terminal:

```sh
scripts/companion.sh setup --repair-sessions
scripts/companion.sh setup --repair-sessions --apply
```

The compatibility alias `scripts/companion.sh repair-sessions [--apply] [--all]` works the same way.

Plugin 3.1.0 stores jobs in one shared data directory: `~/.local/share/kimi-plugin-cc` (or `$XDG_DATA_HOME/kimi-plugin-cc`) on macOS and Linux, and `%LOCALAPPDATA%\kimi-plugin-cc` on Windows. One repair run covers jobs from Claude Code, Codex, Antigravity, DeepSeek Harness, Magpie, and the CLI together. To repair sessions from a custom or 3.0 per-host database, set `KIMI_PLUGIN_CC_DATA` to the parent directory that contains `kimi-plugin-cc/`.

Repair opens the SQLite database in read-only mode without running migrations. It returns JSON status counts along with job and session IDs, omitting prompt bodies. It checks only completed, proven native-v2 sessions when no job is running in the store. For each session, it reads a bounded prefix of the invocation log and verifies the prompt hash against `prompt_digest`.

Repair replaces a preview only when it is blank or matches one of that session's verified plugin prompts (including normalized 40-character prefixes). It writes the newest job's raw request and reports `would-replace-preview` in preview mode or `preview-replaced` when applied. It never overwrites custom previews written by you or Desktop. If repair cannot extract raw request text from a verified prompt, it fills only a blank preview. Job rows, logs, journals, and titles stay untouched, and repair never calls a model.

Repair can report 3 non-replacement status values:

- `unavailable-verified-prompt` when the source log is missing, unsafe, oversized at the start, or fails digest verification
- `state-changed` when another process edits session metadata during repair, so you should retry while idle
- `index-failed` when repair saves metadata but cannot invalidate the index, so you should check directory permissions and retry

Desktop and Web may need a list refresh before repaired previews appear. A session that is already open in another process can also hold older metadata in memory.

Write-swarm sessions run inside a temporary Git worktree that the plugin removes after capturing the patch. Their history stays visible in global views even when a project filter hides the removed worktree path. Repair never rewrites their working directory or provenance.
