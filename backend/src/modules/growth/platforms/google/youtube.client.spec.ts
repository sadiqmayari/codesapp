import { isoDurationSeconds, parseChannel, parseThread, plainText } from './youtube.client';

describe('youtube client helpers', () => {
  it('parses ISO durations', () => {
    expect(isoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(isoDurationSeconds('PT45S')).toBe(45);
    expect(isoDurationSeconds('P1DT1S')).toBe(86401);
    expect(isoDurationSeconds('nope')).toBeNull();
  });
  it('cleans comment text', () => {
    expect(plainText('Hi<br>there &amp; <b>you</b>')).toBe('Hi\nthere & you');
  });
  it('parses a channel', () => {
    expect(parseChannel({ id: 'UC1', snippet: { title: 'Sois', customUrl: '@sois', thumbnails: { medium: { url: 't' } } }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, statistics: { subscriberCount: '48200', viewCount: '9', videoCount: '312' } }))
      .toEqual({ id: 'UC1', title: 'Sois', handle: '@sois', thumb: 't', uploadsPlaylistId: 'UU1', subscribers: 48200, views: 9, videos: 312 });
  });
  it('flattens a thread with replies', () => {
    const rows = parseThread({
      id: 'T1',
      snippet: { videoId: 'v1', topLevelComment: { id: 'C1', snippet: { textOriginal: 'Price?', authorDisplayName: 'A', publishedAt: '2026-11-20T10:00:00Z', moderationStatus: 'published' } } },
      replies: { comments: [{ id: 'C1.r1', snippet: { textOriginal: 'Rs 3,000', authorDisplayName: 'Shop', publishedAt: '2026-11-20T11:00:00Z' } }] },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ externalId: 'C1', parentExternalId: null, videoId: 'v1', text: 'Price?', hidden: false });
    expect(rows[1]).toMatchObject({ externalId: 'C1.r1', parentExternalId: 'C1', videoId: 'v1' });
  });
});
