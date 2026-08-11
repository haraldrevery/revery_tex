import { PdfLatexOptions, CompileResult } from '../core/types';
import { BaseTool } from './base-tool';
export declare class PdfLatex extends BaseTool {
    protected getDriver(): 'pdftex_bibtex8';
    compile(options: PdfLatexOptions): Promise<CompileResult>;
}
//# sourceMappingURL=pdflatex.d.ts.map