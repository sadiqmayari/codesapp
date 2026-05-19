import { OgService } from './og.service';
export declare class OgController {
    private readonly og;
    constructor(og: OgService);
    get(url?: string): Promise<import("./og.service").OgData>;
}
