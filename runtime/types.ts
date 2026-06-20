export type CompanionCommand =
  | "setup"
  | "review"
  | "task"
  | "ask"
  | "status"
  | "result"
  | "cancel"
  | "replay";

export type RuntimeCommandType =
  | "setup"
  | "review"
  | "challenge"
  | "rescue"
  | "review_gate"
  | "ask"
  | "task"
  // Diagnostic/logging label only. Pursue (autonomous goal mode) reuses the
  // rescue *job* lineage (command_type "rescue") so it is NOT a
  // ManagedCommandType; this entry just lets the invocation-log header and
  // formatCommandLabel name it correctly.
  | "pursue"
  // Diagnostic/logging label only. Swarm (read-only parallel fan-out) reuses
  // the review *job* lineage (command_type "review") so it is NOT a
  // ManagedCommandType; this entry only names it in the invocation-log header.
  // The PreToolUse hook label is "swarm" (see runtime/hooks/approval-policy.ts).
  | "swarm"
  // Diagnostic/logging label only. Write-swarm (--write, v1.4) reuses the rescue
  // *job* lineage (command_type "rescue", like pursue) so it is NOT a
  // ManagedCommandType; this entry only names it in the invocation-log header.
  // The PreToolUse hook label is "swarm-write" (runtime/hooks/approval-policy.ts).
  | "swarm-write";

export type ManagedCommandType =
  | "review"
  | "challenge"
  | "rescue"
  | "review_gate"
  | "ask";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobError {
  code: string;
  message: string;
  stage: string;
  details?: Record<string, unknown>;
}

export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}
