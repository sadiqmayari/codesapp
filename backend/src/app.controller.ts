import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Unauthenticated diagnostic: shows the client IP the server resolves
   * (after `trust proxy`). Use this to set SUPER_ADMIN_IP_WHITELIST to the
   * EXACT value the SuperAdminIpGuard compares against. Reveals only the
   * caller's own IP. Lives at /api/_debug/ip (global prefix applies).
   */
  @Get('_debug/ip')
  clientIp(@Req() req: Request) {
    return {
      ip: req.ip,
      ips: req.ips,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      remoteAddress: req.socket?.remoteAddress ?? null,
      hint: 'Put the value of "ip" into SUPER_ADMIN_IP_WHITELIST (comma-separated, no spaces), then redeploy.',
    };
  }
}
