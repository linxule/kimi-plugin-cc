# Session visibility and native titles

Plugin-created sessions live in Kimi Code's local session store and can appear in both Kimi Code Desktop and Node's `kimi web`. Keep Web available: the migration away from the old Python CLI does not retire Node Web.

After a user-command run settles on a native-v2 session, the plugin sets the session's preview line (`lastPrompt`, shown in Kimi Code Desktop and `kimi web`) to that run's own request and notifies the shared index. The request is the question for ask (`/kimi:task`), the task for rescue (`/kimi:task --write`), the objective for pursue and swarm, and `Review target: <target>` for review and challenge (`/kimi:review` with or without `--challenge`), followed by `. Focus: <text>` when a focus was given. It is never the plugin's prefixed prompt and never the answer. The text is redacted using Kimi's credential-pattern rules and limited to 4,000 characters. This applies to fresh and resumed sessions and replaces any preview that differs; an empty value is never written. Print mode never writes `lastPrompt` itself, so without this sync Desktop and Web would hide a completed session as empty. Plugin releases before 3.0.0 wrote the full prefixed prompt there.

One race remains: if you continue the same session in Desktop and that turn finishes after the plugin's run but before its sync, the plugin's sync overwrites that turn's preview. The preview is local display metadata, not a new model prompt.

## Native generated titles

New native-v2 sessions receive a readable fallback such as `Kimi Review: ...`. The prefix names the operation, not the command, so `/kimi:task` sessions start `Kimi Ask:` and `/kimi:task --write` sessions start `Kimi Rescue:`. The fallback is marked **replaceable**, so native title generation can replace it. Existing manual titles and already-generated titles remain unchanged. Older plugin titles marked custom are also preserved because they cannot always be distinguished from a human rename.

In Kimi Code Desktop 1.0.1, open the session's **Rename** control and select **Gen Title** to generate a title from its conversation. Native automatic generation also runs after an eligible turn finishes in Desktop. Merely opening an already-completed plugin session does not trigger it. Kimi's native generator uses its managed login; unavailable authentication or backend errors can leave the fallback in place.

The plugin does not silently call the native title-generation endpoint. That endpoint resumes the session, activates agent services and fires session-start hooks; it is not a metadata-only API. Selecting Gen Title in Desktop is a deliberate native-app action. The plugin makes no extra title-generation provider calls and does not read OAuth credentials.

## Repair existing sessions

Use the companion bundled with the updated plugin (or a freshly built checkout). Run while the target Kimi sessions are idle:

```sh
scripts/companion.sh repair-sessions
scripts/companion.sh repair-sessions --apply
```

The first command previews changes in the current repository; the second applies them. Add `--all` to cover repositories in that host's plugin job store. Claude Code and Codex have separate stores, so run against each relevant host. For a checkout repairing an existing host, select its data parent explicitly with `KIMI_PLUGIN_CC_DATA`; do not point it at the inner `kimi-plugin-cc` directory.

The command reports JSON status counts and job/session IDs, without prompt bodies. It only considers completed, proven native-v2 user-command sessions and excludes sessions with a running job in that store. It recovers the original prompt from a bounded invocation-log prefix and verifies its digest against the job record. It replaces a session's preview only when the preview is blank or is one of that session's own verified plugin prompts: equal after whitespace and redaction normalization, or a prefix of one in either direction where the shorter side has at least 40 characters. It then writes the newest job's raw request, the same text a settled run writes, and reports `would-replace-preview` (preview) or `preview-replaced` (apply). Previews written by you or by Desktop are left alone. When the raw request cannot be derived exactly from the verified prompt, repair only fills a blank preview, with that prompt. Job records, logs, journals and titles stay unchanged. No model is invoked.

`unavailable-verified-prompt` means the source log is missing, unsafe, too large at its start, or does not match the recorded invocation. It is skipped rather than guessed from an answer summary. `state-changed` means a concurrent metadata change was detected: retry when idle. `index-failed` means metadata was saved but index notification failed: fix the directory problem and retry; an unchanged session is still re-indexed on apply.

The index may need its next reconciliation and the UI may need a list refresh before repaired sessions appear. A native session already loaded in another process may hold older in-memory metadata. Repair is not coordinated by a cross-process native lock; keep target sessions idle and reload their view afterward.

Write-swarm sessions belong to their temporary worktree, which is removed after patch capture. Their global history can be visible while an original-project filter omits them. The repair does not rewrite their cwd or change their execution provenance.
