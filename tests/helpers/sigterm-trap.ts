#!/usr/bin/env -S node --import tsx
// SIGTERM-trapping mock kimi for the SIGKILL escalation test in
// cli-client.test.ts. Emits one stream-json record + the session
// announce, then installs a SIGTERM handler that ignores the signal.
// Cli-client must escalate to SIGKILL within `escalationMs`; otherwise
// the test hangs (caught by the `expect(elapsed).toBeLessThan(2_000)`
// upper bound).
//
// Env:
//   KIMI_MOCK_RECORDS         JSON array of records to emit on stdout
//   KIMI_MOCK_SESSION_ID      Session id for the stderr announce
//   SIGTERM_TRAP_SELF_EXIT_MS Optional self-exit window so the
//                             "escalationMs: Infinity opts out" test
//                             eventually completes via clean exit.

const records: unknown[] = (() => {
  const raw = process.env.KIMI_MOCK_RECORDS;
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
const sessionId =
  process.env.KIMI_MOCK_SESSION_ID ?? "00000000-0000-0000-0000-000000000000";
const selfExitMs = Number.parseInt(
  process.env.SIGTERM_TRAP_SELF_EXIT_MS ?? "0",
  10,
);

for (const record of records) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
process.stderr.write(`To resume this session: kimi -r ${sessionId}\n`);

// Install the trap AFTER the announce so cli-client's regex matches.
process.on("SIGTERM", () => {
  // Intentionally swallow SIGTERM. The test expects cli-client to
  // escalate to SIGKILL; if we exit here the assertion (signal ===
  // "SIGKILL") would never observe the escalation.
});

if (selfExitMs > 0) {
  setTimeout(() => process.exit(0), selfExitMs).unref();
}

// Hold the event loop open so SIGTERM has somewhere to land. setInterval
// with an unref'd timer would let the process exit; an unbound setTimeout
// at MAX_INT keeps the loop pinned for any practical test duration.
setTimeout(() => undefined, 0x7fffffff);
