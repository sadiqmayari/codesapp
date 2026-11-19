import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BookableService } from '../ai/agent/packs';
import { DAY_KEYS, DayKey, HoursConfig } from '../ai/agent/profile';

/** Minutes the zone is ahead of UTC at `at` (e.g. Asia/Karachi → +300). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Tenant-local YYYY-MM-DD + HH:MM → UTC instant. */
export function localToInstant(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - off * 60000);
}

/** Tenant-local calendar day of an instant (YYYY-MM-DD) + weekday key. */
export function localDay(at: Date, timeZone: string): { ymd: string; dow: DayKey } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    dow: String(p.weekday).toLowerCase().slice(0, 3) as DayKey,
  };
}

export interface Slot {
  startIso: string;
  label: string;
  remaining: number;
}

/**
 * Appointments / reservations (Appointments skill). Availability = the
 * business-hours schedule split into service-length slots, minus bookings
 * already holding that slot's capacity. Tenant-clock aware.
 */
@Injectable()
export class AgentBookingsService {
  constructor(private readonly prisma: PrismaService) {}

  private label(at: Date, tz: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(at);
  }

  findService(services: BookableService[], name: string): BookableService | null {
    const n = (name || '').trim().toLowerCase();
    if (!services.length) return null;
    if (!n) return services.length === 1 ? services[0] : null;
    return (
      services.find((s) => s.name.toLowerCase() === n) ??
      services.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase())) ??
      null
    );
  }

  /** Free slots for a service from `fromYmd` (default today) over `days` days. */
  async slots(input: {
    companyId: number;
    service: BookableService;
    hours: HoursConfig;
    tz: string;
    fromYmd?: string;
    days?: number;
    leadTimeMin: number;
    maxDaysAhead: number;
    partySize?: number;
    limit?: number;
  }): Promise<Slot[]> {
    const { service, hours, tz } = input;
    const now = new Date();
    const earliest = now.getTime() + input.leadTimeMin * 60000;
    const horizon = now.getTime() + input.maxDaysAhead * 86400000;
    const start = input.fromYmd && /^\d{4}-\d{2}-\d{2}$/.test(input.fromYmd)
      ? localToInstant(input.fromYmd, '00:00', tz)
      : now;
    const days = Math.min(Math.max(input.days ?? 3, 1), 14);

    const candidates: Date[] = [];
    for (let i = 0; i < days + 7 && candidates.length < 400; i++) {
      const dayAt = new Date(start.getTime() + i * 86400000);
      const { ymd, dow } = localDay(dayAt, tz);
      if (hours.holidays.includes(ymd)) continue;
      const day = hours.days[dow];
      if (!day || !day.on) continue;
      let t = localToInstant(ymd, day.open, tz).getTime();
      const close = localToInstant(ymd, day.close, tz).getTime();
      while (t + service.durationMin * 60000 <= close) {
        if (t >= earliest && t <= horizon) candidates.push(new Date(t));
        t += service.durationMin * 60000;
      }
      const distinctDays = new Set(candidates.map((c) => localDay(c, tz).ymd)).size;
      if (distinctDays >= days) break;
    }
    if (!candidates.length) return [];

    const from = candidates[0];
    const to = new Date(candidates[candidates.length - 1].getTime() + service.durationMin * 60000);
    const booked = await this.prisma.aiBooking.findMany({
      where: {
        company_id: input.companyId,
        service: service.name,
        status: 'booked',
        starts_at: { lt: to },
        ends_at: { gt: from },
      },
      select: { starts_at: true, ends_at: true, party_size: true },
    });
    const out: Slot[] = [];
    for (const c of candidates) {
      const end = c.getTime() + service.durationMin * 60000;
      // Each booking holds one capacity unit (a table / chair / doctor).
      const used = booked.filter(
        (b) => b.starts_at.getTime() < end && b.ends_at.getTime() > c.getTime(),
      ).length;
      const remaining = service.capacity - used;
      if (remaining >= 1) {
        out.push({ startIso: c.toISOString(), label: this.label(c, tz), remaining });
      }
      if (out.length >= (input.limit ?? 12)) break;
    }
    return out;
  }

  /** Book a slot (capacity re-checked atomically). */
  async book(input: {
    companyId: number;
    service: BookableService;
    startIso: string;
    tz: string;
    conversationId?: number | null;
    contactId?: number | null;
    name?: string | null;
    phone?: string | null;
    partySize?: number;
    notes?: string | null;
    createdBy?: 'ai' | 'agent';
  }) {
    const starts = new Date(input.startIso);
    if (Number.isNaN(starts.getTime())) throw new BadRequestException('Invalid start time');
    if (starts.getTime() < Date.now()) throw new BadRequestException('That time has passed');
    const ends = new Date(starts.getTime() + input.service.durationMin * 60000);
    return this.prisma.$transaction(async (tx) => {
      const used = await tx.aiBooking.count({
        where: {
          company_id: input.companyId,
          service: input.service.name,
          status: 'booked',
          starts_at: { lt: ends },
          ends_at: { gt: starts },
        },
      });
      if (used >= input.service.capacity) {
        throw new BadRequestException('That slot was just taken — pick another time.');
      }
      return tx.aiBooking.create({
        data: {
          company_id: input.companyId,
          conversation_id: input.conversationId ?? null,
          contact_id: input.contactId ?? null,
          service: input.service.name,
          resource: input.service.resource ?? null,
          starts_at: starts,
          ends_at: ends,
          party_size: Math.max(1, input.partySize ?? 1),
          name: input.name?.slice(0, 160) ?? null,
          phone: input.phone?.slice(0, 32) ?? null,
          notes: input.notes?.slice(0, 2000) ?? null,
          status: 'booked',
          created_by: input.createdBy ?? 'ai',
        },
      });
    });
  }

  async cancel(companyId: number, id: number) {
    const b = await this.prisma.aiBooking.findFirst({ where: { id, company_id: companyId } });
    if (!b) throw new NotFoundException('Booking not found');
    return this.prisma.aiBooking.update({ where: { id }, data: { status: 'cancelled' } });
  }

  /** Upcoming bookings for a contact/conversation. */
  upcomingFor(companyId: number, where: { contactId?: number | null; conversationId?: number | null }) {
    return this.prisma.aiBooking.findMany({
      where: {
        company_id: companyId,
        status: 'booked',
        starts_at: { gte: new Date() },
        OR: [
          ...(where.contactId ? [{ contact_id: where.contactId }] : []),
          ...(where.conversationId ? [{ conversation_id: where.conversationId }] : []),
        ],
      },
      orderBy: { starts_at: 'asc' },
      take: 10,
    });
  }

  /** Admin list (Settings → AI Agent → Bookings). */
  list(companyId: number, from?: Date, to?: Date) {
    return this.prisma.aiBooking.findMany({
      where: {
        company_id: companyId,
        starts_at: { gte: from ?? new Date(Date.now() - 86400000), ...(to ? { lt: to } : {}) },
      },
      orderBy: { starts_at: 'asc' },
      take: 500,
    });
  }
}

export { DAY_KEYS };
