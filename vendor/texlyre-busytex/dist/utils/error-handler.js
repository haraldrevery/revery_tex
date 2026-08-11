// src/utils/error-handling.ts
export class ErrorHandler {
    static handle(error, context) {
        const message = this.getMessage(error);
        const fullMessage = context ? `${context}: ${message}` : message;
        return new Error(fullMessage);
    }
    static getMessage(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}
//# sourceMappingURL=error-handler.js.map