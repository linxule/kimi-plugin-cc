# Vendored TOML parser

This directory contains the parser subset of `smol-toml@1.6.1`, under the
included BSD-3-Clause license. The plugin uses its internal `parseKey`,
`extractValue`, and `skipVoid` interfaces when preserving existing config text.
Newer upstream releases changed those internal interfaces, so replacing this
copy requires a separate integration review.

Security patch: `util.js` includes the EOF-comment guard from upstream commit
[30f5c36](https://github.com/squirrelchat/smol-toml/commit/30f5c36), released in
1.7.1 for [GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).
When an unfinished array or inline table ends with a comment without a newline,
`skipUntil` now throws instead of resetting its cursor and looping forever.
This is the only local change to the vendored JavaScript.

The development dependency uses patched upstream 1.8.0 for round-trip tests;
it does not supply the shipped parser. `bun audit` scans that dependency but
cannot discover issues in this source copy. Review future parser advisories
against both. `tests/runtime/toml-eof-comment.test.ts` checks prompt rejection
in this copy and both shipped mirrors, in a child process with a hard timeout.
