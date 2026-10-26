# Windows community validation

Windows remains unsupported; this is a narrow, credential-free diagnostics lane, not a support announcement. Contributions that reproduce native CLI and Git Bash behavior are welcome in [issue #14](https://github.com/linxule/kimi-plugin-cc/issues/14).

## What is covered

Community [PR #22](https://github.com/linxule/kimi-plugin-cc/pull/22) preserves structured spawn causes and distinguishes argument/resource exhaustion from a missing executable. Its author’s commits remain in the merge history.

The added command-line guard rejects an oversized Windows command before spawn. It counts UTF-16 units, argument quoting and the terminating null. The new error is `CLI_COMMAND_LINE_TOO_LONG`; it identifies prompt size rather than suggesting reinstall/setup. It carries counts, not prompt contents.

The Windows CI lane compiles the runtime, checks quoting with a real short Node subprocess, and sends a 103 KB prompt through the compiled client to prove refusal before spawn. It uses no credentials or provider calls.

## Reproduce the no-model controls

From a source checkout with Node 22.5+ and Bun:

```powershell
bun install --frozen-lockfile
bunx tsc -p tsconfig.build.json
node --test tests/windows/spawn-preflight.mjs
```

These controls do not start Kimi or modify its configuration. The checked-in distribution contains the vendored JavaScript required by the compiled client.

## Evidence that would help next

For a native Kimi or Git Bash report, include:

- Windows, Node, Bun, Kimi and plugin versions; terminal/shell and install method.
- Whether a short invocation works with the same executable and environment.
- Whether a large review now refuses with `CLI_COMMAND_LINE_TOO_LONG`, without starting Kimi, rather than the misleading binary-unavailable error.
- Whether a smaller command still produces ENOENT, EACCES or another structured spawn code, especially through `.cmd` or shell wrappers.
- Sanitized error codes, numeric size fields, test output and an artificial reproducer—not credentials, raw config or a private repository diff.

Do not bypass the managed hook to make a reproduction pass. Native model calls, if a contributor chooses to exercise them, use that contributor's existing configuration and quota; CI does not perform them.

## Still open

The print prompt is still passed in argv. Upstream 2.3.2's audited print entry point has no supported stdin prompt input; an unused stdin helper is not a transport contract. Large reviews above the limit still cannot run through this route. Do not close #14 based only on better error classification or the no-model Windows checks. A new prompt transport needs its own upstream source audit and exact-binary verification, without silently changing prompt/session lineage or hook enforcement.
