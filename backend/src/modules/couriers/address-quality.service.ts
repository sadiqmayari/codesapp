import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../ai/llm.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';

export interface AddressAssessment {
  ok: boolean;
  reason: string | null;
}

/**
 * Auto-detects a likely-bad delivery address before a shipment is booked —
 * the tenant's Google Sheet never did this automatically; the tenant just
 * eyeballed the Address column and typed "Wrong Address" into a dropdown
 * cell. Inspecting ~130 real flagged rows showed the judgment wasn't a
 * single rule: some lacked a house/street number, some were just the city
 * name repeated, but others HAD a plot/flat number and were still flagged
 * for lacking any locality/area name — a completeness/plausibility call, not
 * a regex. So this combines cheap deterministic checks (catch the obvious
 * cases) with an AI plausibility check (catches the "has a unit number but
 * no area" cases a regex can't).
 *
 * Advisory only — never blocks booking outright, only sets Shipment.status
 * to 'address_issue' so an agent can accept (send WhatsApp reconfirm) or
 * override, since the tenant's own manual judgment wasn't perfectly
 * rule-based either.
 */
@Injectable()
export class AddressQualityService {
  private readonly logger = new Logger(AddressQualityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
    private readonly registry: CourierRegistryService,
    private readonly cityMapping: CityMappingService,
  ) {}

  // The AI plausibility check is DISABLED per tenant request: it over-flagged
  // perfectly deliverable Pakistani landmark/shop addresses (a named shop, a
  // petrol pump, a shop number in a market, a plot code like "C66/14") as
  // "missing house/plot number", blocking ~25% of a bulk run before any courier
  // request was even built. Only the cheap deterministic guardrails (empty /
  // city-name-only address, city no courier serves) still flag pre-booking; the
  // couriers themselves reject a genuinely bad address, and inbound tracking
  // still raises address_issue when a rider actually can't find the place.
  // Flip to re-enable the `aiCheck` call below.
  private static readonly AI_CHECK_ENABLED = false;

  async assess(
    companyId: number,
    address: string,
    city: string,
  ): Promise<AddressAssessment> {
    const deterministic = this.deterministicCheck(address, city);
    if (!deterministic.ok) return deterministic;

    const cityKnown = await this.anyCourierKnowsCity(companyId, city);
    if (!cityKnown) {
      return {
        ok: false,
        reason: `City "${city}" is not recognized by any connected courier.`,
      };
    }

    if (!AddressQualityService.AI_CHECK_ENABLED) return { ok: true, reason: null };
    return this.aiCheck(companyId, address, city);
  }

  private deterministicCheck(address: string, city: string): AddressAssessment {
    const trimmed = (address || '').trim();
    const cityNorm = (city || '').trim().toLowerCase();
    const withoutCity = trimmed
      .toLowerCase()
      .replace(cityNorm, '')
      .replace(/[,.\s]+/g, ' ')
      .trim();

    if (withoutCity.length < 6) {
      return { ok: false, reason: 'No street/area detail found beyond the city name.' };
    }
    // "Karachi, Karachi" / "Lahore , Lahore" style — the whole address is
    // just the city name repeated.
    const segments = trimmed
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (segments.length && segments.every((s) => s === cityNorm || s.length <= 3)) {
      return { ok: false, reason: 'Address is just the city name with no other detail.' };
    }

    return { ok: true, reason: null };
  }

  private async anyCourierKnowsCity(companyId: number, city: string): Promise<boolean> {
    const active = await this.registry.getActiveCouriers(companyId);
    for (const courierType of active) {
      if (await this.cityMapping.resolve(companyId, courierType, city)) return true;
    }
    return false;
  }

  private async aiCheck(
    companyId: number,
    address: string,
    city: string,
  ): Promise<AddressAssessment> {
    try {
      await this.metering.assertAllowed(companyId);
    } catch {
      // AI off/capped for this tenant — deterministic-only result stands.
      return { ok: true, reason: null };
    }

    try {
      const result = await this.llm.complete({
        tier: 'fast',
        system: [
          {
            text:
              'You check Pakistani courier delivery addresses for completeness. ' +
              'A GOOD address has enough locality detail (house/plot/flat number ' +
              'AND a street, block, sector, or landmark/area name) for a delivery ' +
              'rider to physically find the place using only that text. Reply with ' +
              'strict JSON only: {"ok": true|false, "reason": "<short reason if not ok, else empty>"}.',
          },
        ],
        userText: `City: ${city}\nAddress: ${address}`,
        maxTokens: 120,
        temperature: 0,
      });
      await this.metering.recordUsage(
        companyId,
        null,
        'address_quality',
        result.provider,
        'fast',
        result.usage,
      );
      const parsed = this.parseJson(result.text);
      if (!parsed) return { ok: true, reason: null };
      return {
        ok: parsed.ok !== false,
        reason: parsed.ok === false ? parsed.reason || 'Address looks incomplete.' : null,
      };
    } catch (err) {
      this.logger.warn(
        `Address AI check failed (company ${companyId}), falling back to deterministic-only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: true, reason: null };
    }
  }

  private parseJson(text: string): { ok?: boolean; reason?: string } | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
