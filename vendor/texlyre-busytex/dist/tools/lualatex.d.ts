import { LuaLatexOptions, CompileResult } from '../core/types';
import { BaseTool } from './base-tool';
export declare class LuaLatex extends BaseTool {
    protected getDriver(): 'luahbtex_bibtex8';
    compile(options: LuaLatexOptions): Promise<CompileResult>;
}
//# sourceMappingURL=lualatex.d.ts.map