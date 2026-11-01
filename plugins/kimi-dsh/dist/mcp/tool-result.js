export function textResult(text, structuredContent, isError = false) {
    return {
        content: [{ type: "text", text }],
        ...(structuredContent ? { structuredContent } : {}),
        isError,
    };
}
