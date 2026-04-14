# ADR 001: Use Kimi Wire as the primary transport

- Status: accepted
- Date: 2026-04-14

## Decision

`kimi-plugin-cc` will use **Kimi Wire** as its primary transport. Print mode is retained only as a fallback for setup/probing or temporary compatibility. ACP is not the primary backend for the Claude Code plugin.

## Context

The quality bar is OpenAI's Codex plugin for Claude Code, which is built around a richer transport/runtime path rather than one-shot CLI output scraping. Kimi offers three plausible integration shapes:

- print mode
- ACP
- Wire

Print mode is simple but non-interactive; in practice, any non-trivial autonomous print-mode flow requires YOLO. ACP is a useful standardized compatibility layer, but Kimi's own docs position it above Wire rather than below it. Wire is the lowest-level, stateful JSON-RPC session bus that exposes prompt submission, approvals, cancellation, replay, and plan mode. The Kimi docs also label Wire as experimental, which is a real project risk rather than a reason to avoid it by default.

## Rationale

Wire is the closest Kimi equivalent to the Codex app-server path because it gives the plugin direct control over:

- long-lived session state
- event streaming
- approval responses
- cancellation
- replay
- capability negotiation

That lets the plugin runtime stay protocol-centric instead of trying to infer state from text output.

## Consequences

- The runtime must implement a proper Wire client.
- Result rendering comes from event stream reconstruction, not a single synchronous response object.
- Setup, review, rescue, and review gate can share one runtime model.
- The implementation is more complex than a print-mode wrapper, but it avoids an architectural dead end.
- The runtime should be built so a future transport swap remains possible if Wire message shapes change materially or Kimi deprecates the interface.
- Phase 1 must re-verify current Wire docs before coding begins.

## Rejected options

### Print mode as primary

Rejected because it is too weak for a Codex-grade plugin:

- non-interactive
- non-trivial automation effectively requires YOLO
- lifecycle inferred from output parsing
- poor foundation for review gate and richer control flow

### ACP as primary

Rejected because it is not the closest equivalent to the native Kimi agent runtime. ACP remains relevant background context, but the plugin should own the lower-level runtime shape directly.
