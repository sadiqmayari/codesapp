import { BotEngineService } from './bot-engine.service';

describe('BotEngineService.matchKeyword', () => {
  it('matches exact keyword case-insensitively after trim', () => {
    expect(BotEngineService.matchKeyword('exact', 'hello', '  Hello  ')).toBe(true);
    expect(BotEngineService.matchKeyword('exact', 'hello', 'hello world')).toBe(false);
    expect(BotEngineService.matchKeyword('exact', 'PRICE', 'price')).toBe(true);
  });

  it('matches contains substring case-insensitively', () => {
    expect(BotEngineService.matchKeyword('contains', 'price', 'What is the PRICE?')).toBe(true);
    expect(BotEngineService.matchKeyword('contains', 'price', 'cost only')).toBe(false);
    expect(BotEngineService.matchKeyword('contains', 'help', 'Need HELP!!')).toBe(true);
  });

  it('matches regex case-insensitively', () => {
    expect(BotEngineService.matchKeyword('regex', '^order\\s+\\d+', 'Order 1234 status?')).toBe(true);
    expect(BotEngineService.matchKeyword('regex', '^order\\s+\\d+', 'My order is late')).toBe(false);
  });

  it('returns false for invalid regex without throwing', () => {
    expect(() =>
      BotEngineService.matchKeyword('regex', '[unclosed', 'anything'),
    ).not.toThrow();
    expect(BotEngineService.matchKeyword('regex', '[unclosed', 'anything')).toBe(false);
  });

  it('does not match empty text against non-empty keyword', () => {
    expect(BotEngineService.matchKeyword('exact', 'hi', '')).toBe(false);
    expect(BotEngineService.matchKeyword('contains', 'hi', '')).toBe(false);
  });
});
