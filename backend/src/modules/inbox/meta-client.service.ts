import {
  Injectable,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { EncryptionService } from '../../common/services/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';

// 20s (was 10s). 10s was too aggressive for media upload/send from the VPS to
// Meta and caused spurious "timed out" failures on otherwise-fine sends. Most
// Meta calls finish in <2s; this is just headroom for a slow one.
const REQUEST_TIMEOUT_MS = 20_000;

export interface MetaContext {
  message_id: string;
}

export interface MetaTextPayload {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
  context?: MetaContext;
}

export interface MetaMediaPayload {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: 'image' | 'audio' | 'video' | 'document';
  image?: { link?: string; id?: string; caption?: string };
  audio?: { link?: string; id?: string };
  video?: { link?: string; id?: string; caption?: string };
  document?: { link?: string; id?: string; caption?: string; filename?: string };
  context?: MetaContext;
}

export interface MetaTemplatePayload {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
  context?: MetaContext;
}

export type MetaSendPayload =
  | MetaTextPayload
  | MetaMediaPayload
  | MetaTemplatePayload;

export interface MetaSendResponse {
  messaging_product: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string }[];
}

/**
 * Thin wrapper around Meta WhatsApp Cloud API.
 * Reads per-company encrypted access tokens via the companies table.
 */
@Injectable()
export class MetaClientService {
  private readonly logger = new Logger(MetaClientService.name);
  private readonly graphVersion: string;
  private readonly graphHost = 'graph.facebook.com';

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.graphVersion = this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  /**
   * Resolve a company's access token. Stored encrypted in `onboarding_status.metaAccessToken`
   * (so we don't add a new column for v1). Returns null if not configured.
   */
  async getAccessToken(companyId: number): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { onboarding_status: true },
    });
    if (!company) return null;

    const onboarding = company.onboarding_status as
      | { metaAccessTokenEncrypted?: string; metaAccessToken?: string }
      | null;
    // Phase 3 canonical key is `metaAccessTokenEncrypted`. Fall back to the
    // Phase 2 `metaAccessToken` key for any pre-migration company rows.
    const enc =
      onboarding?.metaAccessTokenEncrypted ?? onboarding?.metaAccessToken;
    if (!enc) return null;

    try {
      return this.encryption.decrypt(enc);
    } catch {
      this.logger.error(`Failed to decrypt META token for company ${companyId}`);
      return null;
    }
  }

  /**
   * Throws 412 if the company has not completed the Cloud API onboarding
   * wizard. Call this at the start of inbox/broadcast/template-sync Meta
   * operations — NOT from the onboarding step-5 test message (that runs
   * before `completed` is stamped true).
   */
  async assertOnboarded(companyId: number): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { onboarding_status: true },
    });
    const onboarding = (company?.onboarding_status ?? {}) as {
      completed?: boolean;
    };
    if (onboarding.completed !== true) {
      throw new PreconditionFailedException(
        'WhatsApp Cloud API onboarding is not complete for this company. ' +
          'Finish the onboarding wizard before sending messages.',
      );
    }
  }

  async sendMessage(
    companyId: number,
    phoneNumberId: string,
    payload: MetaSendPayload,
  ): Promise<MetaSendResponse> {
    const token = await this.getAccessToken(companyId);
    if (!token) {
      throw new Error(`Meta access token not configured for company ${companyId}`);
    }
    return this.postJson(
      `/${this.graphVersion}/${phoneNumberId}/messages`,
      payload,
      token,
    );
  }

  async sendTemplate(
    companyId: number,
    phoneNumberId: string,
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<MetaSendResponse> {
    return this.sendMessage(companyId, phoneNumberId, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    });
  }

  /**
   * Pre-upload a media file to Meta and get back a reusable media id.
   * POST /{phone_number_id}/media (multipart/form-data). The returned id is
   * then referenced in a subsequent /messages send. Per-tenant access token
   * + phone number id. On Meta failure, throws with Meta's error.message /
   * error.code extracted (same pattern as the onboarding step-5 fix).
   */
  async uploadMedia(
    companyId: number,
    fileBuffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<{ mediaId: string }> {
    const token = await this.getAccessToken(companyId);
    if (!token) {
      throw new Error(`Meta access token not configured for company ${companyId}`);
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { phone_number_id: true },
    });
    if (!company?.phone_number_id) {
      throw new Error(
        `WhatsApp phone number not configured for company ${companyId}`,
      );
    }

    const boundary = `----codesapp${uuidv4()}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="messaging_product"\r\n\r\n' +
        'whatsapp\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="type"\r\n\r\n' +
        `${mimeType}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename.replace(
          /"/g,
          '',
        )}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, fileBuffer, tail]);

    // Retry the upload on a transient failure (Meta throttle / timeout). This is
    // SAFE to retry — a media upload has no customer-visible side effect (a
    // duplicate just yields an unused media id), unlike the /messages send. This
    // is the same pattern downloadMedia uses and fixes the "/media timed out"
    // send failures.
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.requestBuffer<{ id?: string }>(
          `/${this.graphVersion}/${company.phone_number_id}/media`,
          token,
          body,
          `multipart/form-data; boundary=${boundary}`,
        );
        if (!res?.id) {
          throw new Error('Meta media upload did not return a media id');
        }
        return { mediaId: res.id };
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
          this.logger.warn(
            `Media upload attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Meta media upload failed');
  }

  async getMedia(
    companyId: number,
    mediaId: string,
  ): Promise<{ url: string; mime_type: string; sha256?: string; file_size?: number }> {
    const token = await this.getAccessToken(companyId);
    if (!token) throw new Error(`Meta access token missing for company ${companyId}`);

    return this.getJson(`/${this.graphVersion}/${mediaId}`, token);
  }

  /**
   * Stream media from Meta's CDN to local disk. Aborts if size exceeds maxBytes.
   * Returns the absolute path written.
   */
  async downloadMedia(
    companyId: number,
    mediaId: string,
    storageRoot: string,
    maxBytes: number,
  ): Promise<{ path: string; filename: string; mime: string; bytes: number }> {
    // Meta rate-limits/times-out media fetches when a customer sends a burst of
    // messages at once (concurrent worker downloads). A single failure here used
    // to surface as an "(unsupported message)"/"(image)" placeholder in the
    // thread. Retry the WHOLE sequence — the media URL from getMedia is
    // short-lived, so re-fetch it each attempt — before giving up.
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.downloadMediaOnce(
          companyId,
          mediaId,
          storageRoot,
          maxBytes,
        );
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          // 300ms, 900ms backoff — short enough to stay within the job lease,
          // long enough to clear a transient Meta throttle.
          await new Promise((r) => setTimeout(r, 300 * attempt * attempt));
          this.logger.warn(
            `Media ${mediaId} download attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Media ${mediaId} download failed`);
  }

  private async downloadMediaOnce(
    companyId: number,
    mediaId: string,
    storageRoot: string,
    maxBytes: number,
  ): Promise<{ path: string; filename: string; mime: string; bytes: number }> {
    const meta = await this.getMedia(companyId, mediaId);
    const token = await this.getAccessToken(companyId);
    if (!token) throw new Error(`Meta access token missing for company ${companyId}`);

    const now = new Date();
    const dir = path.join(
      storageRoot,
      String(companyId),
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    );
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const ext = this.extFromMime(meta.mime_type);
    const filename = `${uuidv4()}.${ext}`;
    const fullPath = path.join(dir, filename);

    const bytes = await this.streamUrlToFile(meta.url, fullPath, token, maxBytes);
    return { path: fullPath, filename, mime: meta.mime_type, bytes };
  }

  private extFromMime(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/opus': 'opus',
      'audio/amr': 'amr',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
    };
    return map[mime] ?? 'bin';
  }

  private postJson<T>(p: string, body: unknown, token: string): Promise<T> {
    return this.request<T>('POST', p, token, JSON.stringify(body), {
      'content-type': 'application/json',
    });
  }

  private getJson<T>(p: string, token: string): Promise<T> {
    return this.request<T>('GET', p, token);
  }

  private request<T>(
    method: 'GET' | 'POST',
    p: string,
    token: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.graphHost,
          method,
          path: p,
          headers: {
            authorization: `Bearer ${token}`,
            ...extraHeaders,
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw) as T);
              } catch (err) {
                reject(
                  new Error(
                    `Meta API parse error: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
              }
            } else {
              this.logger.warn(
                `Meta API ${method} ${p} → ${res.statusCode} ${raw.slice(0, 500)}`,
              );
              reject(
                new Error(
                  `Meta API ${method} ${p} failed (${res.statusCode}): ${raw.slice(0, 500)}`,
                ),
              );
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Meta API ${method} ${p} timed out`));
      });

      req.on('error', (err) => reject(err));

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * POST a raw Buffer body (used for multipart media upload). On a non-2xx
   * response, parses Meta's `{ error: { message, code } }` and throws with
   * that message so callers can surface the real reason (e.g. unsupported
   * media type, token scope) instead of a blank 500.
   */
  private requestBuffer<T>(
    p: string,
    token: string,
    body: Buffer,
    contentType: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.graphHost,
          method: 'POST',
          path: p,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': contentType,
            'content-length': body.length,
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw) as T);
              } catch (err) {
                reject(
                  new Error(
                    `Meta API parse error: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  ),
                );
              }
            } else {
              this.logger.warn(
                `Meta API POST ${p} → ${res.statusCode} ${raw.slice(0, 500)}`,
              );
              reject(this.extractMetaError(raw, res.statusCode, p));
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Meta API POST ${p} timed out`));
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  private extractMetaError(
    raw: string,
    status: number | undefined,
    p: string,
  ): Error {
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; code?: number };
      };
      if (parsed?.error?.message) {
        const code = parsed.error.code;
        return new Error(
          `Meta API error${code ? ` (${code})` : ''}: ${parsed.error.message}`,
        );
      }
    } catch {
      /* not JSON — fall through */
    }
    return new Error(
      `Meta API POST ${p} failed (${status}): ${raw.slice(0, 500)}`,
    );
  }

  private streamUrlToFile(
    url: string,
    destPath: string,
    token: string,
    maxBytes: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.get(
        {
          host: u.host,
          path: `${u.pathname}${u.search}`,
          headers: { authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`Media download failed: HTTP ${res.statusCode}`));
            return;
          }

          let written = 0;
          let aborted = false;
          const out = fs.createWriteStream(destPath);

          res.on('data', (chunk: Buffer) => {
            if (aborted) return;
            written += chunk.length;
            if (written > maxBytes) {
              aborted = true;
              res.destroy();
              out.destroy();
              fs.unlink(destPath, () => {
                // ignore unlink errors
              });
              reject(
                new Error(
                  `Media exceeded max size ${maxBytes} bytes (got ${written})`,
                ),
              );
              return;
            }
            out.write(chunk);
          });

          res.on('end', () => {
            if (aborted) return;
            out.end(() => resolve(written));
          });
          res.on('error', (err) => {
            if (!aborted) {
              aborted = true;
              out.destroy();
              fs.unlink(destPath, () => {
                // ignore unlink errors
              });
              reject(err);
            }
          });
        },
      );

      req.on('timeout', () => req.destroy(new Error('Media download timed out')));
      req.on('error', reject);
    });
  }
}
