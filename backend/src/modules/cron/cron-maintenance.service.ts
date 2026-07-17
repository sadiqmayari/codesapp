import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { mediaWebPathToDisk } from '../../common/utils/media-path';

const BATCH = 100;

@Injectable()
export class CronMaintenanceService {
  private readonly logger = new Logger(CronMaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async cleanupMedia() {
    const start = Date.now();
    let processed = 0;
    let deleted = 0;
    let ioErrors = 0;

    // Sequential batches — 1-connection budget on Hostinger.
    for (;;) {
      const rows = await this.prisma.message.findMany({
        where: {
          media_expires_at: { lt: new Date() },
          media_expired: false,
        },
        select: { id: true, media_url: true },
        take: BATCH,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        processed++;
        // media_url is the WEB path (/storage/...); the file lives under
        // <cwd>/../storage/…. Resolve to the real disk path before unlink —
        // unlinking the raw web path always ENOENT'd, so nothing was ever
        // actually deleted and media grew unbounded.
        const diskPath = row.media_url
          ? mediaWebPathToDisk(row.media_url)
          : null;
        if (diskPath) {
          try {
            await fs.unlink(diskPath);
            deleted++;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') {
              // already gone — not an error
            } else {
              ioErrors++;
              this.logger.warn(
                `media unlink failed for message ${row.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
        await this.prisma.message.update({
          where: { id: row.id },
          data: { media_expired: true },
        });
      }

      if (rows.length < BATCH) break;
    }

    return { processed, deleted, ioErrors, durationMs: Date.now() - start };
  }

  async cleanupOrphans() {
    const result = await this.prisma.$executeRawUnsafe(
      `UPDATE jobs SET status = 'pending', locked_until = NULL, locked_by = NULL
       WHERE status = 'processing' AND locked_until < NOW()`,
    );
    return { released: Number(result) };
  }

  async purgeOldJobs() {
    const result = await this.prisma.$executeRawUnsafe(
      `DELETE FROM jobs
       WHERE status IN ('completed','failed')
         AND completed_at < (NOW() - INTERVAL 30 DAY)`,
    );
    return { purged: Number(result) };
  }
}
