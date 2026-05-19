import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly storageRoot = path.join(process.cwd(), '..', 'storage', 'media');

  getCompanyMediaDir(companyId: number, date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return path.join(this.storageRoot, String(companyId), String(year), month);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    };
    return map[mime] ?? 'bin';
  }

  saveBuffer(
    buffer: Buffer,
    mime: string,
    companyId: number,
  ): { path: string; filename: string } {
    const dir = this.getCompanyMediaDir(companyId);
    this.ensureDir(dir);

    const filename = `${uuidv4()}.${this.extFromMime(mime)}`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, buffer);

    return { path: fullPath, filename };
  }

  downloadFromUrl(
    url: string,
    companyId: number,
  ): Promise<{ path: string; filename: string }> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        const chunks: Buffer[] = [];
        const mime = res.headers['content-type'] ?? 'application/octet-stream';

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          try {
            const result = this.saveBuffer(buffer, mime, companyId);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      });
    });
  }

  /**
   * Shell-Polish-A: company branding logo. Deterministic filename
   * (logo.{ext}) so a re-upload overwrites in place — no orphan
   * accumulation. Returns the web path persisted on companies.logo_url.
   * `/storage` is served by express.static at <cwd>/../storage (main.ts).
   */
  saveBrandingLogo(
    buffer: Buffer,
    ext: string,
    companyId: number,
  ): { webPath: string } {
    const brandingRoot = path.join(
      this.storageRoot,
      '..',
      'branding',
      String(companyId),
    );
    this.ensureDir(brandingRoot);
    // Remove any prior logo of a different extension so only one remains.
    for (const e of ['jpg', 'jpeg', 'png', 'webp', 'svg']) {
      const prior = path.join(brandingRoot, `logo.${e}`);
      if (e !== ext && fs.existsSync(prior)) {
        try {
          fs.unlinkSync(prior);
        } catch {
          /* best-effort */
        }
      }
    }
    fs.writeFileSync(path.join(brandingRoot, `logo.${ext}`), buffer);
    return { webPath: `/storage/branding/${companyId}/logo.${ext}` };
  }

  /** Best-effort delete of all branding logo files for a company. */
  deleteBrandingLogos(companyId: number): void {
    const brandingRoot = path.join(
      this.storageRoot,
      '..',
      'branding',
      String(companyId),
    );
    for (const e of ['jpg', 'jpeg', 'png', 'webp', 'svg']) {
      const f = path.join(brandingRoot, `logo.${e}`);
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (err) {
        this.logger.warn(`Could not delete branding logo ${f}: ${err}`);
      }
    }
  }

  async deleteFile(absolutePath: string): Promise<void> {
    try {
      await fs.promises.unlink(absolutePath);
    } catch (err) {
      this.logger.warn(`Could not delete file ${absolutePath}: ${err}`);
    }
  }
}
