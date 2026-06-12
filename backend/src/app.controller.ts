import { Controller, Get } from '@nestjs/common';

// A random id minted ONCE per process boot. If two consecutive /health calls
// return different bootId values, the process was restarted in between — this
// is how we detect the "dip to 0 → respawn" cycle WITHOUT host log access.
const BOOT_ID = Math.random().toString(36).slice(2, 10);
const BOOT_AT = Date.now();

@Controller()
export class AppController {
  @Get('health')
  health() {
    const mem = process.memoryUsage();
    const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

    // Count live event-loop resources. A steadily-climbing number across polls
    // means a handle/socket/timer leak (which grows memory until the LVE kills
    // the process — the silent restart). getActiveResourcesInfo is Node 18+;
    // fall back to the older internal counters if unavailable.
    let activeResources: number | string;
    let resourceBreakdown: Record<string, number> | undefined;
    try {
      const info = (
        process as unknown as { getActiveResourcesInfo?: () => string[] }
      ).getActiveResourcesInfo?.();
      if (info) {
        activeResources = info.length;
        resourceBreakdown = info.reduce<Record<string, number>>((acc, r) => {
          acc[r] = (acc[r] ?? 0) + 1;
          return acc;
        }, {});
      } else {
        activeResources = 'unavailable';
      }
    } catch {
      activeResources = 'unavailable';
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      // process identity — pid + bootId change together on a restart
      pid: process.pid,
      bootId: BOOT_ID,
      bootAt: new Date(BOOT_AT).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      // memory in MB — watch rss; if it only ever climbs, that's the leak that
      // ends in a silent OOM kill (no app log, just a dip to 0 then respawn)
      memoryMb: {
        rss: mb(mem.rss),
        heapUsed: mb(mem.heapUsed),
        heapTotal: mb(mem.heapTotal),
        external: mb(mem.external),
        arrayBuffers: mb(mem.arrayBuffers),
      },
      // event-loop resources — climbing = handle/socket/timer leak
      activeResources,
      ...(resourceBreakdown ? { resourceBreakdown } : {}),
    };
  }
}
