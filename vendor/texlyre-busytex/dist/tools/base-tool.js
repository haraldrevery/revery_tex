import { Logger } from '../utils/logger';
export class BaseTool {
    constructor(runner, verbose = false) {
        this.runner = runner;
        this.logger = new Logger(verbose);
    }
    async compile(options) {
        if (!this.runner.isInitialized()) {
            await this.runner.initialize();
        }
        const config = this.runner.getConfig();
        const driver = options.driver ?? this.getDriver();
        if (config.engineMode !== 'combined') {
            const driverEngineMap = {
                'pdftex_bibtex8': 'pdftex',
                'xetex_bibtex8_dvipdfmx': 'xetex',
                'luahbtex_bibtex8': 'luahbtex',
                'luatex_bibtex8': 'luahbtex'
            };
            const requiredEngine = driverEngineMap[driver];
            if (requiredEngine && requiredEngine !== config.engineMode) {
                return {
                    success: false,
                    log: `Engine mismatch: driver "${driver}" requires "${requiredEngine}" but runner is configured with "${config.engineMode}". Use engineMode: "combined" or the matching engine.`,
                    exitCode: 1,
                    logs: []
                };
            }
        }
        const mainTexPath = this.getMainTexPath(options);
        const files = this.prepareFiles(options, mainTexPath);
        return this.runner.compile(files, mainTexPath, options.bibtex ?? null, options.makeindex ?? null, options.rerun ?? null, options.verbose ?? 'silent', driver, options.dataPackagesJs ?? null, options.remoteEndpoint, options.shellEscape ?? false, options.shellHandlerScripts ?? []);
    }
    getMainTexPath(options) {
        return options.mainTexPath ?? 'main.tex';
    }
    prepareFiles(options, mainTexPath) {
        const files = [];
        files.push({ path: mainTexPath, content: options.input });
        if (options.additionalFiles) {
            files.push(...options.additionalFiles);
        }
        return files;
    }
}
//# sourceMappingURL=base-tool.js.map