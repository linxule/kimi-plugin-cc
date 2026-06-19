#!/usr/bin/env -S node --import tsx
// Mock `kimi -p --output-format stream-json` for cli-client tests.
//
// Scripted via env vars so tests can drive scenarios without authoring N
// separate fixture scripts:
//
//   KIMI_MOCK_RECORDS         JSON array of records to emit on stdout, one
//                             per line, each as the canonical kimi-code
//                             stream-json shape.
//   KIMI_MOCK_STDERR_PREFIX   Optional stderr text emitted before the
//                             session announce. Defaults to empty.
//   KIMI_MOCK_STDERR_SUFFIX   Optional stderr text emitted after the
//                             session announce. Defaults to empty.
//   KIMI_MOCK_SESSION_ID      Session id to embed in the stderr announce
//                             line. Defaults to a fixed UUID.
//   KIMI_MOCK_EMIT_ANNOUNCE   "0" to skip the announce line (simulate early
//                             exit). Defaults to "1".
//   KIMI_MOCK_ANNOUNCE_VIA    Which transport carries the resume hint:
//                               "stderr"      — 0.1.x style (default; backward compat)
//                               "stdout-meta" — kimi 0.2.0+ stream-json meta record
//                               "both"        — emit on BOTH channels; tests first-
//                                               announce-wins precedence
//   KIMI_MOCK_EXIT_CODE       Process exit code. Defaults to 0.
//   KIMI_MOCK_INTERLEAVE_LF   "1" to split each record across two writes
//                             with a partial trailing newline, exercising
//                             the parser's chunk-boundary handling.
//   KIMI_MOCK_DELAY_MS        Optional milliseconds to sleep after writing
//                             records but before the session announce / exit.
//                             Useful for testing AbortSignal-driven SIGTERM.
//   KIMI_MOCK_ECHO_ENV        Optional name of an env var the child should echo
//                             back as an extra assistant record
//                             (`<name>=<value|UNSET>`). Lets a test assert that
//                             an env-overlay option (e.g. swarmMaxConcurrency →
//                             KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY) actually
//                             reaches the spawned process, not just the log.

const records: unknown[] = (() => {
  const raw = process.env.KIMI_MOCK_RECORDS;
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
})();

const stderrPrefix = process.env.KIMI_MOCK_STDERR_PREFIX ?? "";
const stderrSuffix = process.env.KIMI_MOCK_STDERR_SUFFIX ?? "";
const sessionId = process.env.KIMI_MOCK_SESSION_ID ?? "00000000-0000-0000-0000-000000000000";
const emitAnnounce = process.env.KIMI_MOCK_EMIT_ANNOUNCE !== "0";
const announceVia = process.env.KIMI_MOCK_ANNOUNCE_VIA ?? "stderr";
const exitCode = Number.parseInt(process.env.KIMI_MOCK_EXIT_CODE ?? "0", 10) || 0;
const interleave = process.env.KIMI_MOCK_INTERLEAVE_LF === "1";
const delayMs = Number.parseInt(process.env.KIMI_MOCK_DELAY_MS ?? "0", 10) || 0;
const echoEnvName = process.env.KIMI_MOCK_ECHO_ENV;

async function main(): Promise<void> {
  if (stderrPrefix.length > 0) {
    process.stderr.write(stderrPrefix.endsWith("\n") ? stderrPrefix : `${stderrPrefix}\n`);
  }

  if (echoEnvName !== undefined && echoEnvName.length > 0) {
    const value = process.env[echoEnvName] ?? "UNSET";
    process.stdout.write(`${JSON.stringify({ role: "assistant", content: `${echoEnvName}=${value}` })}\n`);
  }

  for (const record of records) {
    const line = `${JSON.stringify(record)}\n`;
    if (interleave && line.length > 1) {
      const split = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, split));
      await tick();
      process.stdout.write(line.slice(split));
    } else {
      process.stdout.write(line);
    }
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (emitAnnounce) {
    if (announceVia === "stdout-meta" || announceVia === "both") {
      // kimi-code 0.2.0 stream-json shape from
      // apps/kimi-code/src/cli/run-prompt.ts::writeResumeHint.
      const meta = {
        role: "meta",
        type: "session.resume_hint",
        session_id: sessionId,
        command: `kimi -r ${sessionId}`,
        content: `To resume this session: kimi -r ${sessionId}`,
      };
      process.stdout.write(`${JSON.stringify(meta)}\n`);
    }
    if (announceVia === "stderr" || announceVia === "both") {
      process.stderr.write(`To resume this session: kimi -r ${sessionId}\n`);
    }
  }
  if (stderrSuffix.length > 0) {
    process.stderr.write(stderrSuffix.endsWith("\n") ? stderrSuffix : `${stderrSuffix}\n`);
  }

  process.exit(exitCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

main().catch((err) => {
  process.stderr.write(`mock-kimi-stream fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
