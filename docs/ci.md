# CI

Two GitHub Actions workflows. They are deliberately split because they have very
different cost and trust profiles.

## `ci.yml` — base CI (every push to `main` + every PR)

Runs `bun run check`: build → `tsc --noEmit` → full `bun test` suite → `dist/`
drift gate. **No secrets, no kimi binary, no model tokens** — the real-binary
smokes auto-skip without `KIMI_PLUGIN_CC_SMOKE=1`. This is the per-push safety net
the repo previously only had locally. Nothing to configure; it just runs.

A red `ci.yml` means a real regression: a build break, a type error, a failing
test, or a forgotten `dist/` rebuild (the drift gate).

## `smoke.yml` — real-binary safety gate (run it LOCALLY)

Spawns the **actual** `kimi -p` against a real PreToolUse hook and proves the
safety contract end to end:

1. read-only commands (review/challenge/ask/review_gate) — a forced write is denied;
2. **autonomous goal mode** (`/kimi:pursue`) — zero files land across a full
   multi-turn run, i.e. the hook fires on **every** continuation turn;
3. **write-capable swarm** (`/kimi:swarm --write`) — coder-subagent edits land in
   the throwaway worktree only, the user tree is untouched, and an out-of-root
   write is denied (needs kimi-code ≥ 0.18.0).

### Run it locally — that's the intended path

The natural cadence for this gate is **before a release** (or after a kimi-code
upgrade), and the simplest, cheapest way to do that is **locally against your own
kimi-code subscription** — no secret, no API key, no recurring bill. See
"[Running the same gate locally](#running-the-same-gate-locally)" below. This is
the recommended workflow.

### The CI workflow is optional, manual, and inert by default

`smoke.yml` exists as a convenience for anyone who wants the gate in Actions, but:

- **Manual-dispatch only** (Actions tab → "Real-binary smoke" → Run workflow) —
  nothing runs until you click Run, so nothing bills on its own.
- **No `schedule:`** — a recurring token bill was deliberately rejected. The
  check's natural cadence is "before release", which the local path covers; a
  weekly canary would burn real tokens for marginal benefit.
- **Inert until configured** — without `KIMI_MODEL_API_KEY` the auth-probe step
  logs a warning and skips, so the workflow is safe to keep in the repo unused.

### Secrets are never in the repo

If you *do* opt into CI, the API key lives in **GitHub's encrypted secret store**
(repo Settings → Secrets and variables → Actions). The committed YAML references
only the secret **name** (`${{ secrets.KIMI_MODEL_API_KEY }}`) — the value is
never written to any file in the repo and never appears in logs (Actions masks
it). If you'd rather not manage a CI secret at all, just run the gate locally;
you lose nothing.

### Auth (CI only): API key, not the subscription

When run in CI, the smoke authenticates via kimi-code's **env-model channel**
(`KIMI_MODEL_*`), which points kimi at a provider using an **API key** — a
*separate* billing path from your kimi-code **subscription**. CI uses this (not
the subscription's OAuth) because OAuth tokens **expire**, which makes them
brittle in CI (the smoke would go red whenever the token lapsed). The plugin's
normal runtime never sets `KIMI_MODEL_*`; this is CI-only auth, scoped to the
workflow's env. Locally, your OAuth subscription works directly (next section).

### One-time setup (only if you opt into CI)

Repo → **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `KIMI_MODEL_API_KEY` | a pay-per-token API key (Moonshot / OpenAI / Anthropic) |
| Secret | `KIMI_MODEL_NAME` | the model id to run (e.g. a kimi model) |
| Variable (optional) | `KIMI_MODEL_PROVIDER_TYPE` | `kimi` (default) · `openai` · `anthropic` |
| Variable (optional) | `KIMI_MODEL_BASE_URL` | override the provider base URL (defaults: `kimi` → `https://api.moonshot.ai/v1`, `openai` → `https://api.openai.com/v1`) |

The default provider type `kimi` targets Moonshot's API. Pick whatever provider
your API key is for.

### Running the same gate locally

The smoke is the same one you run by hand. Against your OAuth subscription:

```bash
KIMI_PLUGIN_CC_SMOKE=1 bun test tests/runtime/real-binary-smoke.test.ts
```

Or against a specific release without touching your install (the temp-binary
technique — see [upstream-compat-audit.md](./upstream-compat-audit.md)):

```bash
D=/tmp/kimi-smoke; mkdir -p "$D"; cd "$D"; echo '{"name":"x","private":true}' > package.json
bun add @moonshot-ai/kimi-code@0.18.0; cd -  # >= 0.18.0 to exercise the write-swarm smoke
KIMI_PLUGIN_CC_SMOKE=1 KIMI_PLUGIN_CC_KIMI_BIN="$D/node_modules/.bin/kimi" \
  bun test tests/runtime/real-binary-smoke.test.ts
```

Either OAuth (seeded from `~/.kimi-code`) or env-model (`KIMI_MODEL_*`) auth
satisfies the smoke's gate; see the auth note in `tests/runtime/real-binary-smoke.test.ts`.
