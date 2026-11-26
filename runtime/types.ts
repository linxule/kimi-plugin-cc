export type RuntimeCommandType =
  | "setup"
  | "review"
  | "challenge"
  | "rescue"
  | "ask"
  | "task"
  | "pursue"
  | "swarm"
  | "swarm-write";

export type ManagedCommandType =
  | "review"
  | "challenge"
  | "rescue"
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
  mcpJobId?: string;
  mcpCompanionIdentity?: import("./process-tree.js").ProcessIdentity | null;
  mcpKimiIdentity?: import("./process-tree.js").ProcessIdentity | null;
}
