import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const MAX_BYTES = 2 * 1024 * 1024; // 2MB

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async uploadLogo(
    companyId: number,
    file?: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = MIME_EXT[file.mimetype];
    if (!ext) {
      throw new BadRequestException(
        'Unsupported image type. Use JPEG, PNG, WebP or SVG.',
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Logo must be 2MB or smaller');
    }
    const { webPath } = this.media.saveBrandingLogo(
      file.buffer,
      ext,
      companyId,
    );
    await this.prisma.company.update({
      where: { id: companyId },
      data: { logo_url: webPath },
    });
    return { logo_url: webPath };
  }

  async deleteLogo(companyId: number) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { logo_url: null },
    });
    this.media.deleteBrandingLogos(companyId);
    return { logo_url: null };
  }
}
