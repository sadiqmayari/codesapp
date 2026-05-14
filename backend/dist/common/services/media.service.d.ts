export declare class MediaService {
    private readonly logger;
    private readonly storageRoot;
    getCompanyMediaDir(companyId: number, date?: Date): string;
    private ensureDir;
    private extFromMime;
    saveBuffer(buffer: Buffer, mime: string, companyId: number): {
        path: string;
        filename: string;
    };
    downloadFromUrl(url: string, companyId: number): Promise<{
        path: string;
        filename: string;
    }>;
    deleteFile(absolutePath: string): Promise<void>;
}
