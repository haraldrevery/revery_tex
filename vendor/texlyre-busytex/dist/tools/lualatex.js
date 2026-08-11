import { BaseTool } from './base-tool';
export class LuaLatex extends BaseTool {
    getDriver() {
        return 'luahbtex_bibtex8';
    }
    async compile(options) {
        return super.compile({ ...options, driver: this.getDriver() });
    }
}
//# sourceMappingURL=lualatex.js.map