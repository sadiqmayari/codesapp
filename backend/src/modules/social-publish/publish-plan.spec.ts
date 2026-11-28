import { buildPlan, countHashtags, fillPlaceholders, overallStatus, validatePost } from './publish-plan';

const img = (n: number) => ({ url: `https://x/${n}.jpg`, type: 'image' as const });
const vid = { url: 'https://x/v.mp4', type: 'video' as const };

describe('validatePost', () => {
  it('Instagram needs media and respects caption + hashtag limits', () => {
    expect(validatePost('instagram', 'hi', [])).toContain('Instagram needs a photo or a video');
    expect(validatePost('instagram', 'x'.repeat(2201), [img(1)])[0]).toMatch(/2200/);
    expect(validatePost('instagram', Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), [img(1)])[0]).toMatch(/30 hashtags/);
    expect(validatePost('instagram', 'ok', Array.from({ length: 11 }, (_, i) => img(i)))[0]).toMatch(/10 items/);
    expect(validatePost('instagram', 'ok #a #b', [img(1)])).toEqual([]);
  });
  it('Facebook allows text-only but not empty, and no video + photos mix', () => {
    expect(validatePost('facebook', 'hello', [])).toEqual([]);
    expect(validatePost('facebook', '  ', [])).toHaveLength(1);
    expect(validatePost('facebook', 'x', [vid, img(1)])).toHaveLength(1);
  });
  it('counts hashtags', () => {
    expect(countHashtags('#a b #c d#e')).toBe(2);
  });
});

describe('buildPlan', () => {
  it('Facebook text / photo / video / album', () => {
    expect(buildPlan('facebook', 'hi', [])).toEqual([{ method: 'POST', path: '{page}/feed', body: { message: 'hi' }, save: 'post' }]);
    expect(buildPlan('facebook', 'hi', [img(1)])[0].path).toBe('{page}/photos');
    expect(buildPlan('facebook', 'hi', [vid])[0]).toMatchObject({ path: '{page}/videos', body: { file_url: vid.url, description: 'hi' } });
    const album = buildPlan('facebook', 'hi', [img(1), img(2)]);
    expect(album).toHaveLength(3);
    expect(album[0].body).toMatchObject({ published: false });
    expect(album[2].body).toEqual({ message: 'hi', attached_media: [{ media_fbid: '{photo0}' }, { media_fbid: '{photo1}' }] });
  });
  it('Instagram image, reel and carousel end with media_publish', () => {
    const one = buildPlan('instagram', 'cap', [img(1)]);
    expect(one.map((s) => s.path)).toEqual(['{ig}/media', '{ig}/media_publish']);
    expect(one[0].body).toEqual({ image_url: 'https://x/1.jpg', caption: 'cap' });
    const reel = buildPlan('instagram', 'cap', [vid]);
    expect(reel[0]).toMatchObject({ body: { media_type: 'REELS', video_url: vid.url }, waitReady: true });
    const car = buildPlan('instagram', 'cap', [img(1), vid]);
    expect(car.map((s) => s.save)).toEqual(['child0', 'child1', 'container', 'post']);
    expect(car[2].body).toEqual({ media_type: 'CAROUSEL', children: '{child0},{child1}', caption: 'cap' });
    expect(car[1].waitReady).toBe(true);
  });
});

describe('helpers', () => {
  it('fills placeholders deeply', () => {
    expect(fillPlaceholders({ a: '{x}/y', b: [{ c: '{z}' }], d: 1 }, { x: '1', z: '2' })).toEqual({ a: '1/y', b: [{ c: '2' }], d: 1 });
  });
  it('overall status', () => {
    expect(overallStatus([{ externalId: '1' }, { externalId: '2' }])).toBe('published');
    expect(overallStatus([{ externalId: '1' }, { error: 'x' }])).toBe('partial');
    expect(overallStatus([{ error: 'x' }])).toBe('failed');
  });
});
