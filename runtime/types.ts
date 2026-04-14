export type CompanionCommand =
  | "setup"
  | "review"
  | "task"
  | "ask"
  | "status"
  | "result"
  | "cancel";

export type RuntimeCommandType =
  | "setup"
  | "review"
  | "adversarial_review"
  | "rescue"
  | "review_gate"
  | "ask"
  | "task";

export type ManagedCommandType =
  | "review"
  | "adversarial_review"
  | "rescue"
  | "review_gate"
  | "ask";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobError {
  code: string;
  message: string;
  stage: string;
}

export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}
