import { BusyTexConfig, CompileResult, FileInput, TexliveRemoteFile } from './types';
export declare class BusyTexRunner {
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
//# sourceMappingURL=busytex-runner.d.ts.map