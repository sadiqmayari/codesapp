import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { InvoiceStatementParser } from './parsers/invoice-parser.interface';
import { CourierAccountStatementParser } from './parsers/courier-account-statement.parser';

export interface InvoiceImportResult {
  totalStamped: number;
  totalParsed: number;
  unmatched: string[];
  perFile: Array<{
    file: string;
    courier: string | null;
    parsed: number;
    stamped: number;
    unmatched: number;
    error?: string;
  }>;
}

@Injectable()
export class InvoiceImportService {
  // Coded parser registry — one entry per supported tenant format.
  private readonly parsers: InvoiceStatementParser[] = [new CourierAccountStatementParser()];

  constructor(private readonly prisma: PrismaService) {}

  /** Formats offered in the super-admin dropdown. */
  listFormats(): Array<{ id: string; label: string }> {
    return this.parsers.map((p) => ({ id: p.id, label: p.label }));
  }

  private getParser(formatId: string | null | undefined): InvoiceStatementParser | null {
    if (!formatId) return null;
    return this.parsers.find((p) => p.id === formatId) ?? null;
  }

  /**
   * Parse the uploaded statement files with the tenant's configured parser and
   * stamp the courier invoice number onto matching orders (by order number).
   * Tenant-scoped; requires the feature enabled + a configured format.
   */
  async import(
    companyId: number,
    files: Array<{ buffer: Buffer; originalname: string }>,
  ): Promise<InvoiceImportResult> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { invoice_import_enabled: true, invoice_import_format: true },
    });
    if (!company?.invoice_import_enabled) {
      throw new ForbiddenException("Invoice import isn't enabled for your account.");
    }
    const parser = this.getParser(company.invoice_import_format);
    if (!parser) {
      throw new BadRequestException(
        "Your invoice-import format isn't configured yet — contact CodesApp to set it up.",
      );
    }

    const perFile: InvoiceImportResult['perFile'] = [];
    const unmatched = new Set<string>();
    let totalStamped = 0;
    let totalParsed = 0;

    for (const f of files) {
      let parsed: ReturnType<InvoiceStatementParser['parse']>;
      try {
        parsed = parser.parse(f.buffer, f.originalname);
      } catch {
        perFile.push({ file: f.originalname, courier: null, parsed: 0, stamped: 0, unmatched: 0, error: 'Could not read this file.' });
        continue;
      }
      if (!parsed.mappings.length) {
        perFile.push({ file: f.originalname, courier: parsed.courier, parsed: 0, stamped: 0, unmatched: 0, error: 'No sales rows found in this file.' });
        continue;
      }

      let stamped = 0;
      let fileUnmatched = 0;
      for (const map of parsed.mappings) {
        totalParsed++;
        const data: Prisma.ShopifyOrderUpdateManyMutationInput = {
          courier_invoice_number: map.invoiceNumber,
        };
        if (map.amount != null) data.courier_invoice_amount = new Prisma.Decimal(map.amount);
        if (map.date) {
          const d = new Date(map.date);
          if (!Number.isNaN(d.getTime())) data.courier_invoice_date = d;
        }
        const courier = map.courier ?? parsed.courier;
        if (courier) data.courier_invoice_courier = courier;

        const res = await this.prisma.shopifyOrder.updateMany({
          where: { company_id: companyId, order_name: map.orderName },
          data,
        });
        if (res.count > 0) {
          stamped++;
          totalStamped++;
        } else {
          fileUnmatched++;
          unmatched.add(map.orderName);
        }
      }
      perFile.push({
        file: f.originalname,
        courier: parsed.courier,
        parsed: parsed.mappings.length,
        stamped,
        unmatched: fileUnmatched,
      });
    }

    return { totalStamped, totalParsed, unmatched: [...unmatched], perFile };
  }
}
