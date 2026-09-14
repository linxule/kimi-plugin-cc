# Vendored shell parser

The plugin ships only the `parse()` portion of `shell-quote@1.8.3` (MIT,
James Halliday), adapted to a TypeScript module. It does not ship or call
`quote()`, so the quote-only injection GHSA-w7jw-789q-3m8p is not applicable.

Both token-finalization loops include the upstream 1.9.0 fix from commit
[7ff5488](https://github.com/ljharb/shell-quote/commit/7ff5488599d01c323514f02f5efb74088dd134ec)
for [GHSA-395f-4hp3-45gv](https://github.com/advisories/GHSA-395f-4hp3-45gv).
They append to the existing accumulator instead of repeatedly copying it,
including the callback-environment path, preserving the original token shapes.
The parser's syntax and approval-policy decisions are unchanged.

This vendored code is invisible to package-manager audits. Review upstream
advisories when maintaining dependencies. The bounded Node subprocess test in
`tests/runtime/shell-quote-linear.test.ts` exercises both loops with large
inputs and checks token/object/comment semantics in source and both shipped
mirrors; the existing rescue-approval suite checks policy behavior.
