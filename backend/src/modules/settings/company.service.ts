import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';

const SLUG_RE = /^[a-z0-9-]{2,80}$/;

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

  async getPublicSlug(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { public_slug: true },
    });
    return { public_slug: c?.public_slug ?? null };
  }

  /**
   * Set/change the company's public-tracking slug. Lowercased, validated
   * `^[a-z0-9-]{2,80}$`, globally unique. Empty/null clears it (disables the
   * per-order tracking links until set again).
   */
  async setPublicSlug(companyId: number, raw?: string) {
    const slug = (raw ?? '').trim().toLowerCase();
    if (!slug) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { public_slug: null },
      });
      return { public_slug: null };
    }
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'Slug must be 2–80 characters: lowercase letters, numbers and hyphens only.',
      );
    }
    if (slug.startsWith('-') || slug.endsWith('-')) {
      throw new BadRequestException('Slug cannot start or end with a hyphen.');
    }
    try {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { public_slug: slug },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('That handle is already taken. Try another.');
      }
      throw e;
    }
    return { public_slug: slug };
  }
}
