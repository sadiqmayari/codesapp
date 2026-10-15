import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { google } from 'googleapis';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';

/**
 * Per-tenant Google Drive integration (OAuth2, scope `drive.file`).
 *
 * The app only ever touches files it creates (drive.file is Google's
 * non-sensitive scope → light verification). Each tenant connects their OWN
 * Google account; the refresh token is AES-GCM encrypted at rest and content
 * media lives in THEIR Drive under a per-tenant folder. Playback + thumbnails
 * stream straight from Google to the viewer's browser (the file is shared
 * "anyone with the link → reader"), so bytes never transit our VPS.
 */
@Injectable()
export class GDriveService {
  private readonly logger = new Logger(GDriveService.name);
  private readonly ROOT_FOLDER_NAME = 'CodesApp Content';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  private creds() {
    const clientId = this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException(
        'Google Drive is not configured on this server',
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  private oauthClient() {
    const { clientId, clientSecret, redirectUri } = this.creds();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /** HMAC-sign the companyId so the OAuth `state` round-trip can't be forged. */
  private signState(companyId: number): string {
    const secret = this.config.get<string>('JWT_SECRET') || 'dev';
    const payload = `${companyId}.${Date.now()}`;
    const mac = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${mac}`;
  }

  verifyState(state: string): number | null {
    try {
      const secret = this.config.get<string>('JWT_SECRET') || 'dev';
      const [b64, mac] = state.split('.');
      if (!b64 || !mac) return null;
      const payload = Buffer.from(b64, 'base64url').toString('utf8');
      const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
      if (
        mac.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
      ) {
        return null;
      }
      const [idStr] = payload.split('.');
      const id = Number(idStr);
      return Number.isInteger(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** Consent URL for a tenant to connect their Google Drive. */
  getAuthUrl(companyId: number): string {
    const client = this.oauthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force a refresh_token every time
      include_granted_scopes: true,
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: this.signState(companyId),
    });
  }

  /** Exchange the OAuth code, persist the encrypted refresh token + root folder. */
  async handleCallback(companyId: number, code: string): Promise<void> {
    if (this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key not configured — refusing to store Drive credentials',
      );
    }
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Happens when the user already granted before and Google omits it.
      throw new BadRequestException(
        'Google did not return a refresh token. Disconnect the app in your Google account and reconnect.',
      );
    }
    client.setCredentials(tokens);

    // Best-effort email (display only).
    let email: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const info = await oauth2.userinfo.get();
      email = info.data.email ?? null;
    } catch {
      /* non-fatal */
    }

    // Create the per-tenant root folder.
    const drive = google.drive({ version: 'v3', auth: client });
    const folder = await drive.files.create({
      requestBody: {
        name: this.ROOT_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    const folderId = folder.data.id ?? null;

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        gdrive_refresh_token_encrypted: this.encryption.encrypt(
          tokens.refresh_token,
        ),
        gdrive_email: email,
        gdrive_folder_id: folderId,
        gdrive_connected_at: new Date(),
      },
    });
  }

  async disconnect(companyId: number): Promise<void> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        gdrive_refresh_token_encrypted: null,
        gdrive_email: null,
        gdrive_folder_id: null,
        gdrive_connected_at: null,
      },
    });
  }

  async status(
    companyId: number,
  ): Promise<{ connected: boolean; email: string | null; connectedAt: Date | null }> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        gdrive_refresh_token_encrypted: true,
        gdrive_email: true,
        gdrive_connected_at: true,
      },
    });
    return {
      connected: !!c?.gdrive_refresh_token_encrypted,
      email: c?.gdrive_email ?? null,
      connectedAt: c?.gdrive_connected_at ?? null,
    };
  }

  /** Authed Drive client from the stored refresh token (null if not connected). */
  private async driveFor(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { gdrive_refresh_token_encrypted: true, gdrive_folder_id: true },
    });
    if (!c?.gdrive_refresh_token_encrypted) return null;
    let refreshToken: string;
    try {
      refreshToken = this.encryption.decrypt(c.gdrive_refresh_token_encrypted);
    } catch (e) {
      this.logger.error(`[gdrive] decrypt failed for company ${companyId}`, e);
      return null;
    }
    const client = this.oauthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return {
      drive: google.drive({ version: 'v3', auth: client }),
      folderId: c.gdrive_folder_id,
    };
  }

  /**
   * Upload a buffer into the tenant's content folder and make it
   * link-viewable. Returns the Drive fileId. The caller keeps nothing on disk.
   */
  async upload(
    companyId: number,
    buffer: Buffer,
    mime: string,
    name: string,
  ): Promise<{ fileId: string }> {
    const ctx = await this.driveFor(companyId);
    if (!ctx) {
      throw new BadRequestException('Google Drive is not connected');
    }
    const { drive, folderId } = ctx;
    const created = await drive.files.create({
      requestBody: {
        name,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media: { mimeType: mime, body: Readable.from(buffer) },
      fields: 'id',
    });
    const fileId = created.data.id;
    if (!fileId) throw new ServiceUnavailableException('Drive upload failed');

    // Share "anyone with the link → reader" so the viewer's browser streams
    // the bytes/thumbnail straight from Google (never through our VPS).
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { type: 'anyone', role: 'reader' },
      });
    } catch (e) {
      this.logger.warn(`[gdrive] permission set failed for ${fileId}`, e);
    }
    return { fileId };
  }

  /** Best-effort delete when a content item is removed. */
  async deleteFile(companyId: number, fileId: string): Promise<void> {
    try {
      const ctx = await this.driveFor(companyId);
      if (!ctx) return;
      await ctx.drive.files.delete({ fileId });
    } catch (e) {
      this.logger.warn(`[gdrive] delete failed for ${fileId}`, e);
    }
  }
}
