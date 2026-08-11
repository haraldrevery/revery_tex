import { BaseTool } from './base-tool';
export class PdfLatex extends BaseTool {
    getDriver() {
        return 'pdftex_bibtex8';
    }
    async compile(options) {
        return super.compile({ ...options, driver: this.getDriver() });
    }
}
//# sourceMappingURL=pdflatex.js.map