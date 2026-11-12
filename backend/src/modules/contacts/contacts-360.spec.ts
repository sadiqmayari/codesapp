import { Prisma } from '@prisma/client';
import {
  canonContactPhone,
  isValidContactPhone,
  phoneSearchDigits,
  phoneVariants,
} from '../../common/utils/contact-phone';
import { contactOrderSql, contactWhereSql, normalizeTags } from './contact-query';
import { SegmentsService } from './segments.service';
import { CsvImportService } from './csv-import.service';

const sqlText = (s: Prisma.Sql) => s.sql;

describe('contact phone canonicalization', () => {
  it('stores international digits only', () => {
    expect(canonContactPhone('+92 300 1234567')).toBe('923001234567');
    expect(canonContactPhone('923001234567')).toBe('923001234567');
    expect(canonContactPhone('0300-1234567')).toBe('923001234567');
    expect(canonContactPhone('3001234567')).toBe('923001234567');
    expect(canonContactPhone('00447700900123')).toBe('447700900123');
    expect(canonContactPhone('')).toBe('');
  });
  it('validates length', () => {
    expect(isValidContactPhone('923001234567')).toBe(true);
    expect(isValidContactPhone('12345')).toBe(false);
  });
  it('matches legacy + rows', () => {
    expect(phoneVariants('923001234567')).toEqual(expect.arrayContaining(['923001234567', '+923001234567']));
  });
  it('search digits strip the trunk 0', () => {
    expect(phoneSearchDigits('0300 12')).toBe('30012');
    expect(phoneSearchDigits('ali')).toBe('');
  });
});

describe('contactWhereSql', () => {
  it('always scopes by company and live rows', () => {
    const s = contactWhereSql(42, {});
    expect(sqlText(s)).toContain('company_id = ?');
    expect(sqlText(s)).toContain('deleted_at IS NULL');
    expect(s.values).toContain(42);
  });
  it('filters tags in SQL, AND by default, OR for any', () => {
    const all = contactWhereSql(1, { tags: ['VIP', 'From Ad'] });
    expect(sqlText(all)).toMatch(/LIKE \? AND LOWER/);
    expect(all.values).toContain('%"vip"%');
    const any = contactWhereSql(1, { tags: ['a', 'b'], tagMode: 'any' });
    expect(sqlText(any)).toMatch(/LIKE \? OR LOWER/);
  });
  it('escapes LIKE wildcards', () => {
    const s = contactWhereSql(1, { search: '50%_off' });
    expect(s.values).toContain(String.raw`%50\%\_off%`);
  });
  it('makes a date-only "before" inclusive of that day', () => {
    const s = contactWhereSql(1, { lastMessageBefore: '2026-02-01' });
    expect(sqlText(s)).toContain('last_message_at < ?');
    expect(s.values).toContainEqual(new Date('2026-02-02T00:00:00.000Z'));
  });
  it('sendableOnly drops blocked + opted out', () => {
    const s = sqlText(contactWhereSql(1, { sendableOnly: true }));
    expect(s).toContain("status <> 'blocked'");
    expect(s).toContain('opted_out_at IS NULL');
  });
  it('hasEmail=false also matches empty strings', () => {
    expect(sqlText(contactWhereSql(1, { hasEmail: false }))).toContain("email = ''");
  });
  it('empty id list matches nothing', () => {
    expect(sqlText(contactWhereSql(1, { ids: [] }))).toContain('1 = 0');
  });
  it('sort is whitelisted', () => {
    expect(sqlText(contactOrderSql('name; DROP TABLE x', 'asc'))).toBe('id ASC');
    expect(sqlText(contactOrderSql('name', 'asc'))).toBe('name ASC, id DESC');
  });
});

describe('normalizeTags', () => {
  it('trims, drops empties and dedupes case-insensitively', () => {
    expect(normalizeTags([' VIP ', 'vip', '', 'From Ad', 3])).toEqual(['VIP', 'From Ad']);
  });
});

describe('SegmentsService.toContactFilter', () => {
  it('tolerates legacy blobs', () => {
    expect(SegmentsService.toContactFilter(null)).toMatchObject({ tagMode: 'all' });
    expect(SegmentsService.toContactFilter({ tags: ['x'], hasEmail: true })).toMatchObject({
      tags: ['x'],
      hasEmail: true,
    });
  });
});

describe('CsvImportService.parseFile', () => {
  const svc = new CsvImportService(null as never, null as never, null as never, null as never);
  it('handles an Excel BOM, aliases, ; delimiter and custom columns', () => {
    const csv = '﻿Full Name;Phone Number;E-mail;custom.skin_type\nAli;0300-1234567;ali@x.pk;Oily\n';
    const { rows, errors } = svc.parseFile(Buffer.from(csv));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      name: 'Ali',
      phone: '923001234567',
      email: 'ali@x.pk',
      custom: { skin_type: 'Oily' },
    });
  });
  it('reports bad rows instead of aborting', () => {
    const csv = 'phone,name,email\n12345,Bad,\n923001234567,Ok,nope@\n+923001234567,Dup,\n';
    const { rows, errors } = svc.parseFile(Buffer.from(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBeNull();
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4]);
  });
  it('requires a phone column', () => {
    const { errors } = svc.parseFile(Buffer.from('name\nAli\n'));
    expect(errors[0].reason).toMatch(/No phone column/);
  });
});
