import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaClientService } from '../inbox/meta-client.service';

interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  components?: unknown[];
  rejected_reason?: string;
}

interface MetaTemplateResponse {
  data: MetaTemplate[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class MetaTemplateSyncService {
  private readonly logger = new Logger(MetaTemplateSyncService.name);
  private readonly graphVersion: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metaClient: MetaClientService,
  ) {
    this.graphVersion = this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  async syncFromMeta(companyId: number): Promise<{
    synced: number;
    deleted: number;
  }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { waba_id: true },
    });
    if (!company?.waba_id) {
      throw new Error('WABA ID not configured for this company');
    }

    const token = await this.metaClient.getAccessToken(companyId);
    if (!token) throw new Error('Meta access token missing for company');

    const remote = await this.fetchAllTemplates(company.waba_id, token);
    const remoteIds = new Set(remote.map((t) => t.id));

    let synced = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const t of remote) {
        const category = (t.category ?? 'marketing').toLowerCase();
        const status = this.normalizeStatus(t.status);
        const existing = await tx.template.findFirst({
          where: { company_id: companyId, meta_template_id: t.id },
        });
        const data = {
          company_id: companyId,
          meta_template_id: t.id,
          name: t.name,
          category: this.normalizeCategory(category),
          status,
          content: {
            language: t.language,
            components: t.components ?? [],
          } as unknown as object,
          rejection_reason: t.rejected_reason ?? null,
        };
        if (existing) {
          await tx.template.update({
            where: { id: existing.id },
            data,
          });
        } else {
          await tx.template.create({ data });
        }
        synced++;
      }

      // Mark templates absent from response as deleted (status only — keep history)
      const localTemplates = await tx.template.findMany({
        where: {
          company_id: companyId,
          meta_template_id: { not: null },
          deleted_at: null,
        },
        select: { id: true, meta_template_id: true },
      });
      const toDelete = localTemplates.filter(
        (t) => t.meta_template_id && !remoteIds.has(t.meta_template_id),
      );
      for (const t of toDelete) {
        await tx.template.update({
          where: { id: t.id },
          data: { status: 'rejected', deleted_at: new Date() },
        });
      }
      return toDelete.length;
    });

    return { synced, deleted: 0 };
  }

  /**
   * Submit a new template to Meta. Returns the meta_template_id or null.
   */
  async submitToMeta(
    companyId: number,
    wabaId: string,
    payload: {
      name: string;
      category: string;
      language: string;
      components: unknown[];
    },
  ): Promise<{ id: string | null; error?: string }> {
    const token = await this.metaClient.getAccessToken(companyId);
    if (!token) return { id: null, error: 'Meta token not configured' };

    try {
      const body = JSON.stringify(payload);
      const res = await this.postJson<{ id?: string }>(
        `/${this.graphVersion}/${wabaId}/message_templates`,
        body,
        token,
      );
      return { id: res.id ?? null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: null, error: msg };
    }
  }

  private async fetchAllTemplates(
    wabaId: string,
    token: string,
  ): Promise<MetaTemplate[]> {
    const all: MetaTemplate[] = [];
    let path: string | null =
      `/${this.graphVersion}/${wabaId}/message_templates?limit=100`;

    while (path) {
      const res: MetaTemplateResponse = await this.getJson(path, token);
      all.push(...(res.data ?? []));
      // Use full next URL if present
      if (res.paging?.next) {
        const u = new URL(res.paging.next);
        path = `${u.pathname}${u.search}`;
      } else {
        path = null;
      }
    }
    return all;
  }

  private normalizeStatus(
    s: string,
  ): 'pending' | 'approved' | 'rejected' | 'paused' {
    const lower = (s ?? '').toLowerCase();
    if (lower === 'approved') return 'approved';
    if (lower === 'rejected') return 'rejected';
    if (lower === 'paused' || lower === 'disabled') return 'paused';
    return 'pending';
  }

  private normalizeCategory(
    c: string,
  ): 'marketing' | 'utility' | 'authentication' {
    if (c === 'utility') return 'utility';
    if (c === 'authentication') return 'authentication';
    return 'marketing';
  }

  private getJson<T>(p: string, token: string): Promise<T> {
    return this.request<T>('GET', p, token);
  }

  private postJson<T>(p: string, body: string, token: string): Promise<T> {
    return this.request<T>('POST', p, token, body, {
      'content-type': 'application/json',
    });
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
          host: 'graph.facebook.com',
          method,
          path: p,
          headers: { authorization: `Bearer ${token}`, ...extraHeaders },
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
                reject(err);
              }
            } else {
              this.logger.warn(
                `Meta template ${method} ${p} → ${res.statusCode} ${raw.slice(0, 500)}`,
              );
              reject(
                new Error(
                  `Meta template API failed (${res.statusCode}): ${raw.slice(0, 500)}`,
                ),
              );
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
