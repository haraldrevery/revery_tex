// src/utils/logger.ts
export class Logger {
    constructor(verbose = false) {
        this.verbose = verbose;
    }
    debug(message, ...args) {
        if (this.verbose) {
            console.debug(`[BusyTeX Debug] ${message}`, ...args);
        }
    }
    info(message, ...args) {
        console.info(`[BusyTeX] ${message}`, ...args);
    }
    warn(message, ...args) {
        console.warn(`[BusyTeX Warning] ${message}`, ...args);
    }
    error(message, ...args) {
        console.error(`[BusyTeX Error] ${message}`, ...args);
    }
}
//# sourceMappingURL=logger.js.map