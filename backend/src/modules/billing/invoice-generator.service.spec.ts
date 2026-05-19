import { InvoiceGeneratorService } from './invoice-generator.service';

describe('InvoiceGeneratorService cycle math', () => {
  const anchor = new Date('2026-01-01T00:00:00.000Z');

  it('cycle 0 on activation day', () => {
    expect(
      InvoiceGeneratorService.cycleIndex(anchor, new Date('2026-01-01T12:00:00Z')),
    ).toBe(0);
  });

  it('still cycle 0 at day 29, rolls to cycle 1 at day 30', () => {
    expect(
      InvoiceGeneratorService.cycleIndex(anchor, new Date('2026-01-30T00:00:00Z')),
    ).toBe(0);
    expect(
      InvoiceGeneratorService.cycleIndex(anchor, new Date('2026-01-31T00:00:00Z')),
    ).toBe(1);
  });

  it('cycle 2 at day 60', () => {
    expect(
      InvoiceGeneratorService.cycleIndex(anchor, new Date('2026-03-02T00:00:00Z')),
    ).toBe(2);
  });

  it('negative (clock skew before anchor) → -1', () => {
    expect(
      InvoiceGeneratorService.cycleIndex(anchor, new Date('2025-12-31T00:00:00Z')),
    ).toBe(-1);
  });

  it('cycleStart is anchor + n*30d', () => {
    expect(InvoiceGeneratorService.cycleStart(anchor, 1).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });

  it('invoiceNumber is stable per company+cycleStart', () => {
    const cs = InvoiceGeneratorService.cycleStart(anchor, 2);
    expect(InvoiceGeneratorService.invoiceNumber(42, cs)).toBe(
      'INV-42-20260302',
    );
  });
});
