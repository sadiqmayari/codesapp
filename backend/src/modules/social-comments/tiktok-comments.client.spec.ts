import { parseTikTokComment } from './tiktok-comments.client';

describe('parseTikTokComment', () => {
  it('maps the documented fields', () => {
    const c = parseTikTokComment({
      comment_id: 123, content: 'Price?', ad_id: '9', ad_name: 'Winter', user_name: 'ali',
      create_time: '2026-11-20 10:00:00', status: 'PUBLIC', tiktok_item_id: '77',
    })!;
    expect(c.externalId).toBe('123');
    expect(c.text).toBe('Price?');
    expect(c.authorName).toBe('ali');
    expect(c.postId).toBe('77');
    expect(c.hidden).toBe(false);
    expect(c.commentedAt.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it('accepts alternate names and unix time, flags hidden', () => {
    const c = parseTikTokComment({ id: 'x', text: 'hi', nickname: 'n', create_time: 1763632800, comment_status: 'HIDDEN' })!;
    expect(c.externalId).toBe('x');
    expect(c.authorName).toBe('n');
    expect(c.hidden).toBe(true);
    expect(c.commentedAt.getTime()).toBe(1763632800 * 1000);
  });

  it('parses the live 2026-11 row shape', () => {
    const c = parseTikTokComment({
      ad_id: '0', ad_name: null, campaign_name: 'Men Gummies 13 May', comment_id: '7709', comment_status: 'PUBLIC',
      comment_type: 'COMMENT', content: 'I have not received my parcel', create_time: '2026-11-19 11:01:20 +0000 UTC',
      user_name: 'x', tiktok_item_id: '7675',
    })!;
    expect(c.adId).toBeNull();
    expect(c.adName).toBe('Men Gummies 13 May');
    expect(c.commentedAt.toISOString()).toBe('2026-11-19T11:01:20.000Z');
    expect(c.hidden).toBe(false);
  });

  it('drops rows without id or text', () => {
    expect(parseTikTokComment({ content: 'a' })).toBeNull();
    expect(parseTikTokComment({ comment_id: 1 })).toBeNull();
  });
});
