import { SegmentsService } from './segments.service';

describe('SegmentsService.buildContactWhere', () => {
  it('always scopes by company and excludes soft-deleted', () => {
    const where = SegmentsService.buildContactWhere(42, {});
    expect(where.company_id).toBe(42);
    expect(where.deleted_at).toBeNull();
  });

  it('passes status straight through', () => {
    const where = SegmentsService.buildContactWhere(1, { status: 'blocked' as never });
    expect(where.status).toBe('blocked');
  });

  it('translates hasEmail=true to { not: null } and false to null', () => {
    const trueWhere = SegmentsService.buildContactWhere(1, { hasEmail: true });
    expect(trueWhere.email).toEqual({ not: null });

    const falseWhere = SegmentsService.buildContactWhere(1, { hasEmail: false });
    expect(falseWhere.email).toBeNull();
  });

  it('combines lastMessageAfter and lastMessageBefore into gte/lte range', () => {
    const where = SegmentsService.buildContactWhere(1, {
      lastMessageAfter: '2026-01-01T00:00:00.000Z',
      lastMessageBefore: '2026-02-01T00:00:00.000Z',
    });
    expect(where.last_message_at).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lte: new Date('2026-02-01T00:00:00.000Z'),
    });
  });

  it('omits last_message_at when neither bound is set', () => {
    const where = SegmentsService.buildContactWhere(1, {});
    expect(where.last_message_at).toBeUndefined();
  });
});
