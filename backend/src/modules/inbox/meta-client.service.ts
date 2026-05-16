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

const REQUEST_TIMEOUT_MS = 10_000;

export interface MetaTextPayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export interface MetaMediaPayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'image' | 'audio' | 'video' | 'document';
  image?: { link?: string; id?: string; caption?: string };
  audio?: { link?: string; id?: string };
  video?: { link?: string; id?: string; caption?: string };
  document?: { link?: string; id?: string; caption?: string; filename?: string };
}

export interface MetaTemplatePayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
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
