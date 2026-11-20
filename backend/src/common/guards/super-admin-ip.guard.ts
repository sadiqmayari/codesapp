import { clientIp } from '../utils/ip-match';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Super-admin IP allow-list.
 *
 * SUPER_ADMIN_IP_WHITELIST accepts a comma-separated list of:
 *   - exact IPs            e.g. 39.38.120.112
 *   - IPv4 CIDR ranges     e.g. 39.38.0.0/16   (cover a dynamic-IP ISP block)
 *   - the wildcard "*"     disables the IP restriction entirely
 *
 * "*" is an explicit, owner-chosen escape hatch for dynamic-IP environments
 * (trades IP-locking for accessibility). Prefer a CIDR range over "*" when
 * you can; lock back down once your IP is stable.
 */
@Injectable()
export class SuperAdminIpGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminIpGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV');
    if (nodeEnv === 'development') return true;

    const req = context.switchToHttp().getRequest();
    // Real client IP behind Cloudflare/Traefik (req.ip = the spoofable
    // left-most X-Forwarded-For entry with trust proxy on).
    const ip: string = clientIp(req);

    const whitelist = (
      this.config.get<string>('SUPER_ADMIN_IP_WHITELIST') ?? ''
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (whitelist.includes('*')) {
      this.logger.warn(
        'SUPER_ADMIN_IP_WHITELIST="*" — IP restriction DISABLED (owner opt-out).',
      );
      return true;
    }

    const allowed = whitelist.some((entry) =>
      entry.includes('/') ? this.inCidr(ip, entry) : entry === ip,
    );

    if (!allowed) {
      throw new ForbiddenException(
        `Access denied: IP not whitelisted. Detected IP: "${ip}". ` +
          `Add it to SUPER_ADMIN_IP_WHITELIST (exact IP, a CIDR range like ` +
          `${this.suggestCidr(ip)}, or "*" to disable), then restart.`,
      );
    }

    return true;
  }

  /** IPv4 CIDR membership test. Non-IPv4 / malformed → false. */
  private inCidr(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const a = this.toLong(ip);
    const b = this.toLong(range);
    if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
    return (a & mask) === (b & mask);
  }

  private toLong(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out = (out << 8) | n;
    }
    return out >>> 0;
  }

  private suggestCidr(ip: string): string {
    const parts = ip.split('.');
    return parts.length === 4
      ? `${parts[0]}.${parts[1]}.0.0/16`
      : 'x.x.0.0/16';
  }
}
