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
  | "task";

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
