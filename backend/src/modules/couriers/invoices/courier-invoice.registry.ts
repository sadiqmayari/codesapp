import { BadRequestException, Injectable } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { COURIER_DISPLAY_NAME } from '../couriers.constants';
import { CourierInvoiceParser } from './courier-invoice-parser.interface';
import { RocketInvoiceParser } from './rocket-invoice.parser';
import { PostexInvoiceParser } from './postex-invoice.parser';
import { TraxInvoiceParser } from './trax-invoice.parser';

/**
 * Courier → statement parser. Only couriers with a parser can have their invoice
 * uploaded; the rest fail with a clear message instead of being fed to a
 * best-guess parser that would mis-read money.
 *
 * Adding a courier = write its parser against a REAL sample file, register it
 * here. Nothing else changes.
 */
@Injectable()
export class CourierInvoiceRegistry {
  private readonly parsers = new Map<CourierType, CourierInvoiceParser>();

  constructor(
    rocket: RocketInvoiceParser,
    postex: PostexInvoiceParser,
    trax: TraxInvoiceParser,
  ) {
    this.parsers.set(rocket.courier, rocket);
    this.parsers.set(postex.courier, postex);
    this.parsers.set(trax.courier, trax);
  }

  /** Couriers that currently accept an invoice upload (drives the UI's picker). */
  supportedCouriers(): CourierType[] {
    return [...this.parsers.keys()];
  }

  getParser(courier: CourierType): CourierInvoiceParser {
    const p = this.parsers.get(courier);
    if (!p) {
      throw new BadRequestException(
        `Invoice upload isn't supported for ${COURIER_DISPLAY_NAME[courier]} yet — ` +
          `every courier formats its statement differently, so it needs its own reader. ` +
          `Send a sample ${COURIER_DISPLAY_NAME[courier]} statement and it can be added.`,
      );
    }
    return p;
  }
}
