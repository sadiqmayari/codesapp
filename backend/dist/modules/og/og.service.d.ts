import { CacheService } from '../../common/services/cache.service';
export interface OgData {
    url: string;
    title: string | null;
    description: string | null;
    image: string | null;
    site_name: string | null;
    fetched_at: string;
    ok: boolean;
}
type RawResponse = {
    kind: 'response';
    statusCode: number;
    contentType: string;
    body: Buffer;
} | {
    kind: 'redirect';
    location: string;
} | {
    kind: 'oversize';
} | {
    kind: 'timeout';
} | {
    kind: 'error';
};
export declare class OgService {
    private readonly cache;
    private readonly logger;
    constructor(cache: CacheService);
    getPreview(rawUrl?: string): Promise<OgData>;
    private miss;
    private fetchOg;
    protected hostBlockReason(u: URL): Promise<string | null>;
    protected resolveAddresses(host: string): Promise<string[]>;
    private isBlockedIp;
    private isBlockedV4;
    private isBlockedV6;
    protected httpRequest(u: URL, timeoutMs: number): Promise<RawResponse>;
    private parse;
    private metaByAttr;
    private attrValue;
    private clean;
    private decodeEntities;
}
export {};
