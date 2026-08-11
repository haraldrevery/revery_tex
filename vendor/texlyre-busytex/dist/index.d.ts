interface BusyTexConfig {
    busytexBasePath?: string;
    verbose?: boolean;
    engineMode?: EngineMode;
    preloadDataPackages?: string[];
    catalogDataPackages?: string[];
    initRetries?: number;
    initRetryDelayMs?: number;
    onDownloadProgress?: (progress: DownloadProgress) => void;
}
interface DownloadProgress {
    loaded: number;
    total: number;
    percent: number;
}
type EngineMode = 'combined' | 'pdftex' | 'xetex' | 'luahbtex';
interface CompileOptions {
    input: string;
    mainTexPath?: string;
    bibtex?: boolean;
    makeindex?: boolean;
    rerun?: boolean;
    verbose?: 'silent' | 'info' | 'debug';
    driver?: 'xetex_bibtex8_dvipdfmx' | 'pdftex_bibtex8' | 'luahbtex_bibtex8' | 'luatex_bibtex8';
    dataPackagesJs?: string[];
    additionalFiles?: FileInput[];
    remoteEndpoint?: string;
    shellEscape?: boolean;
    shellHandlerScripts?: string[];
}
interface FileInput {
    path: string;
    content: string | Uint8Array;
}
interface TexliveRemoteFile {
    name: string;
    format?: number;
    content: Uint8Array | string;
}
interface CompileResult {
    success: boolean;
    pdf?: Uint8Array;
    synctex?: Uint8Array;
    log: string;
    exitCode: number;
    logs: LogEntry[];
}
interface LogEntry {
    cmd: string;
    texmflog: string;
    missfontlog: string;
    log: string;
    aux: string;
    stdout: string;
    stderr: string;
    exit_code: number;
}
interface PdfLatexOptions extends CompileOptions {
}
interface XeLatexOptions extends CompileOptions {
}
interface LuaLatexOptions extends CompileOptions {
}

declare class BusyTexRunner {
    private config;
    private logger;
    private initialized;
    private worker;
    private busytexPipeline;
    constructor(config?: BusyTexConfig);
    initialize(useWorker?: boolean): Promise<void>;
    private clearPreloadDataPackageCache;
    private initializeWorker;
    private initializeDirect;
    private reportDownloadProgress;
    private getEngineAssetNames;
    private convertFilesToBusyTexFormat;
    compile(files: FileInput[], mainTexPath: string, bibtex?: boolean | null, makeindex?: boolean | null, rerun?: boolean | null, verbose?: 'silent' | 'info' | 'debug', driver?: 'xetex_bibtex8_dvipdfmx' | 'pdftex_bibtex8' | 'luahbtex_bibtex8' | 'luatex_bibtex8', dataPackagesJs?: string[] | null, remoteEndpoint?: string, shellEscape?: boolean, shellHandlerScripts?: string[]): Promise<CompileResult>;
    private compileWithWorker;
    private compileDirect;
    readProjectFiles(dir?: string): Promise<FileInput[]>;
    writeTexliveRemoteFiles(files: TexliveRemoteFile[]): Promise<void>;
    writeTexliveRemoteMisses(keys: string[]): Promise<void>;
    isPackageCached(packageJsUrl: string): Promise<boolean>;
    deletePackageCache(packageJsUrl: string): Promise<void>;
    clearAllPackageCache(): Promise<void>;
    terminate(): void;
    isInitialized(): boolean;
    getConfig(): Required<BusyTexConfig>;
}

declare class Logger {
    private verbose;
    constructor(verbose?: boolean);
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}

declare abstract class BaseTool {
    protected runner: BusyTexRunner;
    protected logger: Logger;
    constructor(runner: BusyTexRunner, verbose?: boolean);
    protected abstract getDriver(): 'xetex_bibtex8_dvipdfmx' | 'pdftex_bibtex8' | 'luahbtex_bibtex8' | 'luatex_bibtex8';
    compile(options: CompileOptions): Promise<CompileResult>;
    getMainTexPath(options: CompileOptions): string;
    private prepareFiles;
}

declare class PdfLatex extends BaseTool {
    protected getDriver(): 'pdftex_bibtex8';
    compile(options: PdfLatexOptions): Promise<CompileResult>;
}

declare class XeLatex extends BaseTool {
    protected getDriver(): 'xetex_bibtex8_dvipdfmx';
    compile(options: XeLatexOptions): Promise<CompileResult>;
}

declare class LuaLatex extends BaseTool {
    protected getDriver(): 'luahbtex_bibtex8';
    compile(options: LuaLatexOptions): Promise<CompileResult>;
}

declare function ensureCacheVersion(): Promise<void>;
declare function isPackageCached(packageJsUrl: string): Promise<boolean>;
declare function deletePackageCache(packageJsUrl: string): Promise<void>;
declare function clearAllPackageCache(): Promise<void>;

export { BusyTexRunner, Logger, LuaLatex, PdfLatex, XeLatex, clearAllPackageCache, deletePackageCache, ensureCacheVersion, isPackageCached };
export type { BusyTexConfig, CompileOptions, CompileResult, DownloadProgress, EngineMode, FileInput, LogEntry, LuaLatexOptions, PdfLatexOptions, TexliveRemoteFile, XeLatexOptions };
