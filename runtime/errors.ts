export class RuntimeError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, stage: string, options?: ErrorOptions & { details?: Record<string, unknown> }) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
    this.stage = stage;
    this.details = options?.details ?? {};
  }
}

export function formatError(error: unknown): string {
  if (error instanceof RuntimeError) {
    return `[${error.code}] [${error.stage}] ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
