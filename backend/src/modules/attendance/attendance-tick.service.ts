import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runsBackground } from '../../common/utils/process-role';
import { AttendanceService } from './attendance.service';

const TICK_MS = 10 * 60_000;

/**
 * Attendance background tick: drops sockets of members whose app just locked
 * (after shift end) and runs the hourly auto-absent / missed-check-out sweep
 * (AttendanceService.dailySweep). Auto-checkout was REMOVED (Nov-2026) — the
 * system never closes a day; a forgotten check-out is flagged missed_checkout
 * and fixed via a correction request. Runs in the WORKER process only
 * (runsBackground) on a 10-minute tick, so it can't run twice.
 */
@Injectable()
export class AttendanceTickService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AttendanceTickService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSweep = 0;
  private readonly lockedUsers = new Set<number>();

  constructor(private readonly attendance: AttendanceService) {}

  onModuleInit() {
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // "Lock app after shift end": drop the sockets of members who just locked.
      const l = await this.attendance.disconnectLockedMembers(this.lockedUsers);
      if (l.dropped) this.log.log(`work-hours lock signed out ${l.dropped} member(s)`);
      // Auto-absent: the nightly sweep runs from here (hourly, idempotent) so it
      // no longer depends on an external cron entry — it was never scheduled.
      if (Date.now() - this.lastSweep >= 60 * 60_000) {
        this.lastSweep = Date.now();
        const sw = await this.attendance.dailySweep();
        if (sw.absentMarked || sw.missedCheckoutFlagged) {
          this.log.log(`attendance sweep: ${sw.absentMarked} absent, ${sw.missedCheckoutFlagged} missed check-out`);
        }
      }
    } catch (e) {
      this.log.warn(`attendance tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
