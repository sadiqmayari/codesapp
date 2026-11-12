import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { CacheService } from '../../common/services/cache.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { loadEffectiveLimits } from '../../common/utils/effective-limits-loader';
import {
  canonContactPhone,
  isValidContactPhone,
} from '../../common/utils/contact-phone';
import { normalizeTags, tagsOf } from './contact-query';

export type ImportMode = 'skip' | 'update';

export interface CsvRowError {
  row: number;
  reason: string;
}

export interface CsvImportSummary {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  capped: boolean;
  total: number;
  errors: CsvRowError[];
}

export interface CsvImportJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  processed: number;
  total: number;
  summary?: CsvImportSummary;
  error?: string;
}

/** Above this many rows the import runs in the background (request returns a jobId). */
const SYNC_MAX_ROWS = 2000;
const BATCH = 500;
const MAX_ERRORS = 500;
const JOB_TTL_SEC = 6 * 3600;

/**
 * Header aliases (case/space/punctuation-insensitive). `custom.<key>` or
 * `custom_<key>` columns land in `custom_fields`; anything unrecognized is ignored.
 */
const ALIASES: Record<string, string> = {
  phone: 'phone', phonenumber: 'phone', mobile: 'phone', mobilenumber: 'phone',
  whatsapp: 'phone', whatsappnumber: 'phone', cell: 'phone', contactnumber: 'phone',
  number: 'phone', msisdn: 'phone',
  name: 'name', fullname: 'name', customername: 'name', contactname: 'name',
  firstname: 'first_name', lastname: 'last_name',
  email: 'email', emailaddress: 'email', mail: 'email',
  city: 'city', town: 'city',
  address: 'address', streetaddress: 'address', shippingaddress: 'address', address1: 'address',
  tags: 'tags', tag: 'tags', labels: 'tags', segment: 'tags',
};

const keyOf = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParsedRow {
  line: number;
  phone: string;
  name: string;
  email: string | null;
  city: string | null;
  address: string | null;
  tags: string[];
  custom: Record<string, string>;
}

@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    private readonly cache: CacheService,
    private readonly platformSetting: PlatformSettingService,
  ) {}

  /**
   * Parse + validate, then either import inline (≤ SYNC_MAX_ROWS) or start a
   * background run and return `{ jobId }` for polling. A malformed row is
   * reported per-row; it never aborts the whole file.
   */
  async import(
    companyId: number,
    fileBuffer: Buffer,
    mode: ImportMode = 'skip',
    userId?: number,
  ): Promise<CsvImportSummary | CsvImportJob> {
    const { rows, errors } = this.parseFile(fileBuffer);
    if (rows.length + errors.length <= SYNC_MAX_ROWS) {
      return this.run(companyId, rows, errors, mode, undefined, userId);
    }
    const jobId = randomUUID();
    const job: CsvImportJob = { jobId, status: 'running', processed: 0, total: rows.length };
    this.cache.set(this.jobKey(companyId, jobId), job, JOB_TTL_SEC);
    void this.run(companyId, rows, errors, mode, (processed) => {
      this.cache.set(this.jobKey(companyId, jobId), { ...job, processed }, JOB_TTL_SEC);
    }, userId)
      .then((summary) =>
        this.cache.set(
          this.jobKey(companyId, jobId),
          { ...job, status: 'done', processed: rows.length, summary },
          JOB_TTL_SEC,
        ),
      )
      .catch((err) => {
        this.logger.error(`CSV import job ${jobId} failed: ${err instanceof Error ? err.message : err}`);
        this.cache.set(
          this.jobKey(companyId, jobId),
          { ...job, status: 'failed', error: 'Import stopped unexpectedly — rows already saved are kept' },
          JOB_TTL_SEC,
        );
      });
    return job;
  }

  getJob(companyId: number, jobId: string): CsvImportJob {
    const job = this.cache.get<CsvImportJob>(this.jobKey(companyId, jobId));
    if (!job) throw new NotFoundException('Import job not found or expired');
    return job;
  }

  private jobKey(companyId: number, jobId: string) {
    return `contacts-import:${companyId}:${jobId}`;
  }

  /** Exposed for tests. */
  parseFile(buf: Buffer): { rows: ParsedRow[]; errors: CsvRowError[] } {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const delimiter =
      (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

    let records: string[][];
    try {
      records = parse(text, {
        delimiter,
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        trim: true,
      }) as string[][];
    } catch (err) {
      return {
        rows: [],
        errors: [{ row: 1, reason: `File could not be read as CSV: ${err instanceof Error ? err.message : err}` }],
      };
    }
    if (!records.length) return { rows: [], errors: [{ row: 1, reason: 'File is empty' }] };

    const header = records[0].map((h) => {
      const raw = h.replace(/^﻿/, '').trim();
      const m = raw.match(/^custom[._\s-](.+)$/i);
      if (m) return `custom:${m[1].trim().slice(0, 64)}`;
      return ALIASES[keyOf(raw)] ?? '';
    });
    if (!header.includes('phone')) {
      return {
        rows: [],
        errors: [{ row: 1, reason: 'No phone column found (expected a header like "phone", "mobile" or "WhatsApp")' }],
      };
    }

    const rows: ParsedRow[] = [];
    const errors: CsvRowError[] = [];
    const seen = new Map<string, number>();
    for (let i = 1; i < records.length; i++) {
      const rec = records[i];
      const line = i + 1;
      const get = (k: string) => {
        const idx = header.indexOf(k);
        return idx >= 0 ? (rec[idx] ?? '').trim() : '';
      };
      const rawPhone = get('phone');
      const phone = canonContactPhone(rawPhone);
      if (!rawPhone) {
        errors.push({ row: line, reason: 'Phone is empty' });
        continue;
      }
      if (!isValidContactPhone(phone)) {
        errors.push({ row: line, reason: `Phone "${rawPhone.slice(0, 30)}" is not a valid number` });
        continue;
      }
      const dupLine = seen.get(phone);
      if (dupLine) {
        errors.push({ row: line, reason: `Same phone as row ${dupLine} in this file` });
        continue;
      }
      seen.set(phone, line);

      const name =
        get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ') || phone;
      const emailRaw = get('email');
      if (emailRaw && !EMAIL_RE.test(emailRaw)) {
        errors.push({ row: line, reason: `Email "${emailRaw.slice(0, 60)}" is not valid (row kept, email dropped)` });
      }
      const custom: Record<string, string> = {};
      header.forEach((h, idx) => {
        if (h.startsWith('custom:')) {
          const v = (rec[idx] ?? '').trim();
          if (v) custom[h.slice(7)] = v.slice(0, 1000);
        }
      });
      rows.push({
        line,
        phone,
        name: name.slice(0, 255),
        email: emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw.slice(0, 191) : null,
        city: get('city').slice(0, 128) || null,
        address: get('address').slice(0, 500) || null,
        tags: normalizeTags(get('tags').split(/[,|;]/)),
        custom,
      });
    }
    return { rows, errors };
  }

  private async run(
    companyId: number,
    rows: ParsedRow[],
    parseErrors: CsvRowError[],
    mode: ImportMode,
    onProgress?: (processed: number) => void,
    userId?: number,
  ): Promise<CsvImportSummary> {
    const limits = await loadEffectiveLimits(this.prisma, this.cache, companyId);
    const action = await this.limitAction(companyId);
    const cap = action === 'warn_only' ? Number.POSITIVE_INFINITY : limits?.contact_limit ?? 0;

    // Cap against the LIVE stored total (not the monthly metering counter).
    let stored = await this.prisma.contact.count({ where: { company_id: companyId, deleted_at: null } });

    const summary: CsvImportSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      invalid: parseErrors.filter((e) => !/row kept/.test(e.reason)).length,
      capped: false,
      total: rows.length + parseErrors.filter((e) => !/row kept/.test(e.reason)).length,
      errors: parseErrors.slice(0, MAX_ERRORS),
    };
    const pushErr = (e: CsvRowError) => {
      if (summary.errors.length < MAX_ERRORS) summary.errors.push(e);
    };

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const variants = batch.flatMap((r) => [r.phone, '+' + r.phone]);
      const existing = await this.prisma.contact.findMany({
        where: { company_id: companyId, deleted_at: null, phone: { in: variants } },
        select: { id: true, phone: true, name: true, email: true, city: true, address: true, tags: true, custom_fields: true },
      });
      const byPhone = new Map(existing.map((e) => [canonContactPhone(e.phone), e]));

      const toCreate: Prisma.ContactCreateManyInput[] = [];
      for (const r of batch) {
        const ex = byPhone.get(r.phone);
        if (ex) {
          if (mode === 'skip') {
            summary.skipped++;
            continue;
          }
          // Update: fill blanks, merge tags + custom fields; keep the known name
          // unless it's just the number echoed back.
          const looksLikePhone = /^\+?\d+$/.test(ex.name.trim());
          try {
            await this.prisma.contact.updateMany({
              where: { id: ex.id, company_id: companyId },
              data: {
                name: looksLikePhone && r.name !== r.phone ? r.name : ex.name,
                email: ex.email || r.email,
                city: ex.city || r.city,
                address: ex.address || r.address,
                tags: normalizeTags([...tagsOf(ex.tags), ...r.tags]),
                custom_fields: {
                  ...(ex.custom_fields && typeof ex.custom_fields === 'object' ? (ex.custom_fields as object) : {}),
                  ...r.custom,
                } as Prisma.InputJsonValue,
              },
            });
            summary.updated++;
          } catch (err) {
            summary.invalid++;
            pushErr({ row: r.line, reason: 'Could not update the existing contact' });
            this.logger.warn(`CSV update failed row ${r.line}: ${err instanceof Error ? err.message : err}`);
          }
          continue;
        }
        if (stored + toCreate.length >= cap) {
          summary.capped = true;
          break;
        }
        toCreate.push({
          company_id: companyId,
          name: r.name,
          phone: r.phone,
          email: r.email,
          city: r.city,
          address: r.address,
          tags: r.tags,
          custom_fields: r.custom as Prisma.InputJsonValue,
        });
      }

      if (toCreate.length) {
        try {
          const res = await this.prisma.contact.createMany({ data: toCreate });
          summary.created += res.count;
          stored += res.count;
          await this.metering.incrementContacts(companyId, res.count);
        } catch (err) {
          // Fall back row-by-row so one bad row doesn't sink the batch.
          for (const c of toCreate) {
            try {
              await this.prisma.contact.create({ data: c });
              summary.created++;
              stored++;
              await this.metering.incrementContacts(companyId);
            } catch (e) {
              summary.invalid++;
              const line = batch.find((b) => b.phone === c.phone)?.line ?? 0;
              pushErr({ row: line, reason: 'Could not be saved' });
              this.logger.warn(`CSV row ${line} insert failed: ${e instanceof Error ? e.message : e}`);
            }
          }
          this.logger.warn(`CSV createMany fell back to per-row: ${err instanceof Error ? err.message : err}`);
        }
      }
      onProgress?.(Math.min(rows.length, i + BATCH));
      if (summary.capped) break;
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          company_id: companyId,
          user_id: userId ?? null,
          action: 'contact.imported',
          entity: 'contact',
          metadata: {
            created: summary.created,
            updated: summary.updated,
            skipped: summary.skipped,
            invalid: summary.invalid,
            capped: summary.capped,
            mode,
          },
        },
      });
    } catch {
      /* audit is best-effort */
    }
    return summary;
  }

  private async limitAction(companyId: number): Promise<'block' | 'warn_only'> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { usage_limit_action: true },
    });
    return (company?.usage_limit_action as 'block' | 'warn_only' | null) ??
      (await this.platformSetting.getUsageLimitAction());
  }
}
