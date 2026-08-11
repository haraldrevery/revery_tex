import { BusyTexRunner } from '../core/busytex-runner';
import { CompileResult, CompileOptions } from '../core/types';
import { Logger } from '../utils/logger';
export declare abstract class BaseTool {
    protected runner: BusyTexRunner;
    protected logger: Logger;
    constructor(runner: BusyTexRunner, verbose?: boolean);
    protected abstract getDriver(): 'xetex_bibtex8_dvipdfmx' | 'pdftex_bibtex8' | 'luahbtex_bibtex8' | 'luatex_bibtex8';
    compile(options: CompileOptions): Promise<CompileResult>;
    getMainTexPath(options: CompileOptions): string;
    private prepareFiles;
}
//# sourceMappingURL=base-tool.d.ts.map