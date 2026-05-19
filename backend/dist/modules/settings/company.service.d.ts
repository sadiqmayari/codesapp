import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
export declare class CompanyService {
    private readonly prisma;
    private readonly media;
    constructor(prisma: PrismaService, media: MediaService);
    uploadLogo(companyId: number, file?: {
        buffer: Buffer;
        mimetype: string;
        size: number;
    }): Promise<{
        logo_url: string;
    }>;
    deleteLogo(companyId: number): Promise<{
        logo_url: null;
    }>;
}
