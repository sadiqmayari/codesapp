import { Injectable, Logger } from '@nestjs/common';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { CacheService } from '../../common/services/cache.service';
import { PHONE_REGEX } from './dto/create-contact.dto';

export interface CsvImportSummary {
  created: number;
  skipped: number;
  invalid: number;
  capped: boolean;
}

@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    private readonly cache: CacheService,
  ) {}

  async import(
    companyId: number,
    fileBuffer: Buffer,
  ): Promise<CsvImportSummary> {
    const subscription = await this.getSubscription(companyId);
    const period = new Date().toISOString().slice(0, 7);

    let currentStored =
      (
        await this.prisma.usageMetering.findUnique({
          where: { company_id_period: { company_id: companyId, period } },
          select: { contacts_stored: true },
        })
      )?.contacts_stored ?? 0;

    const summary: CsvImportSummary = {
      created: 0,
      skipped: 0,
      invalid: 0,
      capped: false,
    };

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const source = Readable.from(fileBuffer);
    source.pipe(parser);

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      const phone = (row.phone ?? '').trim();
      if (!PHONE_REGEX.test(phone)) {
        summary.invalid++;
        continue;
      }
      if (currentStored >= subscription.contact_limit) {
        summary.capped = true;
        break;
      }

      const existing = await this.prisma.contact.findFirst({
        where: {
          company_id: companyId,
          phone,
          deleted_at: null,
        },
        select: { id: true },
      });
      if (existing) {
        summary.skipped++;
        continue;
      }

      const tags = (row.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      try {
        await this.prisma.contact.create({
          data: {
            company_id: companyId,
            name: (row.name ?? phone).slice(0, 255),
            phone,
            email: row.email?.trim() || null,
            tags,
            custom_fields: {},
          },
        });
        await this.metering.incrementContacts(companyId);
        currentStored++;
        summary.created++;
      } catch (err) {
        this.logger.warn(
          `CSV row insert failed (phone=${phone}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        summary.invalid++;
      }
    }

    return summary;
  }

  private async getSubscription(
    companyId: number,
  ): Promise<{ contact_limit: number }> {
    const cacheKey = this.cache.subscriptionKey(companyId);
    const cached = this.cache.get<{ contact_limit: number }>(cacheKey);
    if (cached) return cached;

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: { select: { contact_limit: true } } },
    });
    if (!company) throw new Error('Company not found');
    this.cache.set(cacheKey, company.subscription, 300);
    return company.subscription;
  }
}
