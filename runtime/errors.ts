export class RuntimeError extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(code: string, message: string, stage: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
    this.stage = stage;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
