import { BadRequestException } from '@nestjs/common';
import { CompanyService } from './company.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';

function build() {
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    company: {
      update: jest.fn().mockImplementation((args: { data: object }) => {
        updated.push(args.data as Record<string, unknown>);
        return Promise.resolve({ id: 1, ...args.data });
      }),
    },
  } as unknown as PrismaService;
  const media = {
    saveBrandingLogo: jest
      .fn()
      .mockReturnValue({ webPath: '/storage/branding/1/logo.png' }),
    deleteBrandingLogos: jest.fn(),
  } as unknown as MediaService;
  const service = new CompanyService(prisma, media);
  return { service, prisma, media, updated };
}

describe('CompanyService.uploadLogo', () => {
  it('rejects an oversized file with 400', async () => {
    const { service } = build();
    await expect(
      service.uploadLogo(1, {
        buffer: Buffer.alloc(10),
        mimetype: 'image/png',
        size: 3 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a disallowed mime type with 400', async () => {
    const { service } = build();
    await expect(
      service.uploadLogo(1, {
        buffer: Buffer.alloc(10),
        mimetype: 'application/pdf',
        size: 100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing file with 400', async () => {
    const { service } = build();
    await expect(service.uploadLogo(1, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('persists the web path on companies.logo_url (happy path)', async () => {
    const { service, updated } = build();
    const res = await service.uploadLogo(1, {
      buffer: Buffer.from('x'),
      mimetype: 'image/png',
      size: 100,
    });
    expect(res).toEqual({ logo_url: '/storage/branding/1/logo.png' });
    expect(updated[0]).toEqual({ logo_url: '/storage/branding/1/logo.png' });
  });
});

describe('CompanyService.deleteLogo', () => {
  it('nulls logo_url and best-effort deletes files', async () => {
    const { service, updated, media } = build();
    const res = await service.deleteLogo(1);
    expect(res).toEqual({ logo_url: null });
    expect(updated[0]).toEqual({ logo_url: null });
    expect(media.deleteBrandingLogos).toHaveBeenCalledWith(1);
  });
});
