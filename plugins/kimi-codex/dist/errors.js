export class RuntimeError extends Error {
    code;
    stage;
    details;
    constructor(code, message, stage, options) {
        super(message, options);
        this.name = "RuntimeError";
        this.code = code;
        this.stage = stage;
        this.details = options?.details ?? {};
    }
}
export function formatError(error) {
    if (error instanceof RuntimeError) {
        return `[${error.code}] [${error.stage}] ${error.message}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
