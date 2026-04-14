export class RuntimeError extends Error {
    code;
    stage;
    constructor(code, message, stage, options) {
        super(message, options);
        this.name = "RuntimeError";
        this.code = code;
        this.stage = stage;
    }
}
export function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
