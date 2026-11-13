import { classifySearch, clampQuery, escapeLike, likeContains, likePrefix } from './search';
import { phoneSearchDigits } from './contact-phone';

describe('search utils', () => {
  describe('escapeLike / likeContains / likePrefix', () => {
    it('escapes LIKE wildcards and the escape char', () => {
      expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
      expect(likeContains('a_b')).toBe('%a\\_b%');
      expect(likePrefix('lah%')).toBe('lah\\%%');
    });
    it('leaves normal text alone', () => {
      expect(likeContains('Ayesha')).toBe('%Ayesha%');
    });
  });

  describe('classifySearch', () => {
    it('order numbers', () => {
      expect(classifySearch('#1001')).toMatchObject({ kind: 'order', orderNo: '1001' });
      expect(classifySearch(' 1001 ')).toMatchObject({ kind: 'order', orderNo: '1001' });
    });
    it('phones in every PK format share the same last-10 tail', () => {
      const a = classifySearch('0300 123-4567');
      const b = classifySearch('+923001234567');
      const c = classifySearch('923001234567');
      for (const x of [a, b, c]) expect(x.kind).toBe('phone');
      expect(a.phoneTail).toBe('3001234567');
      expect(b.phoneTail).toBe('3001234567');
      expect(c.phoneTail).toBe('3001234567');
    });
    it('tracking numbers', () => {
      expect(classifySearch('TRX88120034').kind).toBe('tracking');
      expect(classifySearch('88120034').kind).toBe('tracking'); // 8 digits: not an order, not a phone
    });
    it('free text', () => {
      expect(classifySearch('ayesha khan').kind).toBe('text');
      expect(classifySearch('').kind).toBe('text');
      expect(classifySearch(null).raw).toBe('');
    });
  });

  describe('clampQuery', () => {
    it('trims and caps length', () => {
      expect(clampQuery('  hi  ')).toBe('hi');
      expect(clampQuery('x'.repeat(500)).length).toBe(100);
      expect(clampQuery(undefined)).toBe('');
    });
  });

  describe('phoneSearchDigits', () => {
    it('strips the trunk 0', () => {
      expect(phoneSearchDigits('0300 1234567')).toBe('3001234567');
    });
    it('rejects fragments that are too short AFTER stripping', () => {
      expect(phoneSearchDigits('030')).toBe('');
      expect(phoneSearchDigits('12')).toBe('');
      expect(phoneSearchDigits('0301')).toBe('301');
    });
  });
});
