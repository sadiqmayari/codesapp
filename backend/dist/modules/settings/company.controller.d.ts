import { CompanyService } from './company.service';
export declare class CompanyController {
    private readonly companyService;
    constructor(companyService: CompanyService);
    uploadLogo(user: {
        companyId: number;
    }, file?: {
        buffer: Buffer;
        mimetype: string;
        size: number;
    }): Promise<{
        logo_url: string;
    }>;
    deleteLogo(user: {
        companyId: number;
    }): Promise<{
        logo_url: null;
    }>;
}
