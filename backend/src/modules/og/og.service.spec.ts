import { BadRequestException } from '@nestjs/common';
import { OgService } from './og.service';
import { CacheService } from '../../common/services/cache.service';

type Raw =
  | { kind: 'response'; statusCode: number; contentType: string; body: Buffer }
  | { kind: 'redirect'; location: string }
  | { kind: 'oversize' }
  | { kind: 'timeout' }
  | { kind: 'error' };

function html(body: string): Raw {
  return {
    kind: 'response',
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(body, 'utf8'),
  };
}

function build() {
  const cache = new CacheService();
  const service = new OgService(cache);
  // public IP so SSRF host validation passes for any hostname
  jest
    .spyOn(service as any, 'resolveAddresses')
    .mockResolvedValue(['93.184.216.34']);
  const http = jest.fn();
  jest.spyOn(service as any, 'httpRequest').mockImplementation(http as any);
  return { service, cache, http };
}

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Hello &amp; World">
<meta property="og:description" content="A nice page">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Example Co">
<title>Fallback Title</title>
</head><body>x</body></html>`;

describe('OgService.getPreview — parsing', () => {
  it('parses og:title/description/image/site_name', async () => {
    const { service, http } = build();
    http.mockResolvedValue(html(PAGE));
    const r = await service.getPreview('https://example.com/page');
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Hello & World'); // entity decoded
    expect(r.description).toBe('A nice page');
    expect(r.image).toBe('https://example.com/img/cover.png'); // relative resolved
    expect(r.site_name).toBe('Example Co');
  });

  it('falls back to <title> when og:title is missing', async () => {
    const { service, http } = build();
    http.mockResolvedValue(
      html('<html><head><title>Just A Title</title></head></html>'),
    );
    const r = await service.getPreview('https://example.com/');
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Just A Title');
  });

  it('falls back to meta name=description when og:description is missing', async () => {
    const { service, http } = build();
    http.mockResolvedValue(
      html(
        '<html><head><title>T</title><meta name="description" content="Meta desc"></head></html>',
      ),
    );
    const r = await service.getPreview('https://example.com/');
    expect(r.description).toBe('Meta desc');
  });
});

describe('OgService.getPreview — SSRF / input validation', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://172.16.0.5/',
    'http://localhost/',
    'http://localhost.localdomain/',
  ])('rejects %s with 400', async (u) => {
    const { service } = build();
    await expect(service.getPreview(u)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-http(s) scheme with 400', async () => {
    const { service } = build();
    await expect(
      service.getPreview('ftp://example.com/x'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing url with 400', async () => {
    const { service } = build();
    await expect(service.getPreview(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a malformed url with 400', async () => {
    const { service } = build();
    await expect(service.getPreview('notaurl')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('blocks a hostname that resolves to a private IP (400)', async () => {
    const { service } = build();
    jest
      .spyOn(service as any, 'resolveAddresses')
      .mockResolvedValue(['10.1.2.3']);
    await expect(
      service.getPreview('https://internal.evil.test/'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OgService.getPreview — best-effort failures (never throw)', () => {
  it('non-html content-type → ok:false', async () => {
    const { service, http } = build();
    http.mockResolvedValue({
      kind: 'response',
      statusCode: 200,
      contentType: 'application/json',
      body: Buffer.from('{}'),
    });
    const r = await service.getPreview('https://example.com/');
    expect(r.ok).toBe(false);
    expect(r.title).toBeNull();
  });

  it('oversize body → ok:false', async () => {
    const { service, http } = build();
    http.mockResolvedValue({ kind: 'oversize' });
    const r = await service.getPreview('https://example.com/');
    expect(r.ok).toBe(false);
  });

  it('timeout → ok:false', async () => {
    const { service, http } = build();
    http.mockResolvedValue({ kind: 'timeout' });
    const r = await service.getPreview('https://example.com/');
    expect(r.ok).toBe(false);
  });

  it('4 redirects (exceeds 3-hop cap) → ok:false', async () => {
    const { service, http } = build();
    http.mockResolvedValue({
      kind: 'redirect',
      location: 'https://example.com/next',
    });
    const r = await service.getPreview('https://example.com/start');
    expect(r.ok).toBe(false);
    // hop 0,1,2,3 attempted then the 4th redirect bails
    expect(http).toHaveBeenCalledTimes(4);
  });

  it('redirect to a private IP → ok:false', async () => {
    const { service, http } = build();
    http.mockResolvedValueOnce({
      kind: 'redirect',
      location: 'http://169.254.169.254/latest/',
    });
    const r = await service.getPreview('https://example.com/start');
    expect(r.ok).toBe(false);
  });
});

describe('OgService.getPreview — cache', () => {
  it('cache hit returns the same object without re-fetching', async () => {
    const { service, http } = build();
    http.mockResolvedValue(html(PAGE));
    const a = await service.getPreview('https://example.com/cached');
    const b = await service.getPreview('https://example.com/cached');
    expect(b).toBe(a);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
