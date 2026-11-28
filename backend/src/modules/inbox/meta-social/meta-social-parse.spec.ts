import { parseMetaSocial, socialSerialKey } from './parse';

const PAGE = '111';
const IG = '17841400000000000';

describe('parseMetaSocial', () => {
  it('ignores WhatsApp payloads', () => {
    const r = parseMetaSocial({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [] }] });
    expect(r.object).toBeNull();
    expect(r.messaging).toHaveLength(0);
  });

  it('parses a Messenger text + image message', () => {
    const r = parseMetaSocial({
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'psid1' },
              recipient: { id: PAGE },
              timestamp: 1700000000123,
              message: {
                mid: 'm_1',
                text: 'Is it in stock?',
                attachments: [{ type: 'image', payload: { url: 'https://cdn.fb/x.jpg' } }],
                reply_to: { mid: 'm_0' },
              },
            },
          ],
        },
      ],
    });
    expect(r.object).toBe('page');
    expect(r.messaging).toHaveLength(1);
    const m = r.messaging[0];
    expect(m).toMatchObject({
      kind: 'message',
      channel: 'messenger',
      accountId: PAGE,
      userId: 'psid1',
      mid: 'm_1',
      text: 'Is it in stock?',
      replyToMid: 'm_0',
      timestamp: 1700000000123,
    });
    expect(m.attachments[0]).toEqual({ type: 'image', url: 'https://cdn.fb/x.jpg', title: null });
  });

  it('treats an echo as ours and keys it by the recipient', () => {
    const r = parseMetaSocial({
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: PAGE },
              recipient: { id: 'psid1' },
              timestamp: 1700000000000,
              message: { mid: 'm_2', text: 'Yes!', is_echo: true, app_id: 263902037430900 },
            },
          ],
        },
      ],
    });
    expect(r.messaging[0]).toMatchObject({ kind: 'echo', userId: 'psid1', appId: '263902037430900' });
  });

  it('parses read, delivery and reaction events', () => {
    const r = parseMetaSocial({
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            { sender: { id: 'p' }, recipient: { id: PAGE }, timestamp: 1, read: { watermark: 1700000000500 } },
            { sender: { id: 'p' }, recipient: { id: PAGE }, timestamp: 1, delivery: { mids: ['a', 'b'], watermark: 1 } },
            { sender: { id: 'p' }, recipient: { id: PAGE }, timestamp: 1, reaction: { mid: 'a', action: 'react', emoji: '❤' } },
            { sender: { id: 'p' }, recipient: { id: PAGE }, timestamp: 1, reaction: { mid: 'a', action: 'unreact' } },
          ],
        },
      ],
    });
    expect(r.messaging.map((m) => m.kind)).toEqual(['read', 'delivery', 'reaction', 'reaction']);
    expect(r.messaging[0].watermark).toBe(1700000000500);
    expect(r.messaging[1].mids).toEqual(['a', 'b']);
    expect(r.messaging[2].emoji).toBe('❤');
    expect(r.messaging[3].emoji).toBeNull();
  });

  it('parses an Instagram DM', () => {
    const r = parseMetaSocial({
      object: 'instagram',
      entry: [
        {
          id: IG,
          messaging: [
            { sender: { id: 'igsid' }, recipient: { id: IG }, timestamp: 1700000000000, message: { mid: 'ig_1', text: 'price?' } },
          ],
        },
      ],
    });
    expect(r.messaging[0]).toMatchObject({ channel: 'instagram', accountId: IG, userId: 'igsid', text: 'price?' });
  });

  it('parses Page feed comments, marks own replies and nested parents', () => {
    const r = parseMetaSocial({
      object: 'page',
      entry: [
        {
          id: PAGE,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'post_c1',
                post_id: 'post',
                parent_id: 'post',
                message: 'Size chart please',
                from: { id: 'u1', name: 'Usman' },
                created_time: 1700000000,
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'post_c2',
                post_id: 'post',
                parent_id: 'post_c1',
                message: 'Sent in DM',
                from: { id: PAGE, name: 'Sois Life' },
                created_time: 1700000100,
              },
            },
            { field: 'feed', value: { item: 'reaction', verb: 'add' } },
          ],
        },
      ],
    });
    expect(r.comments).toHaveLength(2);
    expect(r.comments[0]).toMatchObject({
      platform: 'facebook',
      commentId: 'post_c1',
      parentId: null,
      text: 'Size chart please',
      authorName: 'Usman',
      fromSelf: false,
    });
    expect(r.comments[0].createdAt.getTime()).toBe(1700000000000);
    expect(r.comments[1]).toMatchObject({ parentId: 'post_c1', fromSelf: true });
  });

  it('parses Instagram comments incl. ad media', () => {
    const r = parseMetaSocial({
      object: 'instagram',
      entry: [
        {
          id: IG,
          time: 1700000000,
          changes: [
            {
              field: 'comments',
              value: {
                id: 'c9',
                text: 'Karachi delivery?',
                from: { id: 'u2', username: 'zara' },
                media: { id: 'media1', ad_id: 'ad7', ad_title: 'Winter drop' },
              },
            },
          ],
        },
      ],
    });
    expect(r.comments[0]).toMatchObject({
      platform: 'instagram',
      commentId: 'c9',
      postId: 'media1',
      authorName: 'zara',
      adId: 'ad7',
      adName: 'Winter drop',
    });
  });
});

describe('socialSerialKey', () => {
  it('keys a single-customer payload and skips comment payloads', () => {
    expect(
      socialSerialKey({
        object: 'page',
        entry: [{ id: PAGE, messaging: [{ sender: { id: 'p1' }, recipient: { id: PAGE }, timestamp: 1, message: { mid: 'x', text: 'hi' } }] }],
      }),
    ).toBe(`conv:fb:${PAGE}:p1`);
    expect(
      socialSerialKey({
        object: 'page',
        entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', comment_id: 'c', post_id: 'p', message: 'x' } }] }],
      }),
    ).toBeUndefined();
  });
});
