import { BaseTool } from './base-tool';
export class XeLatex extends BaseTool {
    getDriver() {
        return 'xetex_bibtex8_dvipdfmx';
    }
    async compile(options) {
        return super.compile({ ...options, driver: this.getDriver() });
    }
}
//# sourceMappingURL=xelatex.js.map