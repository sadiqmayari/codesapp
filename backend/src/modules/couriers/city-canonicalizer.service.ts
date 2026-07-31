import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';

/**
 * Maps a customer-typed, free-text order city (e.g. "North Karachi",
 * "karachi pakistan", "saddar karachi", "Karachii", "Kkarachi") onto a single
 * CANONICAL Pakistani city drawn from the seeded `courier_city_mappings` table
 * (the same ~4.8k-city list couriers book against). Without this, the courier
 * performance / routing views splinter one real city into dozens of near-
 * duplicate rows.
 *
 * Resolution is layered, cheapest-and-safest first, and NEVER guesses wildly:
 *   1. exact match on the cleaned string,
 *   2. exact match after stripping province/country noise tokens,
 *   3. longest canonical n-gram appearing as whole words inside the string
 *      (so "north karachi" / "karachi pakistan" → "karachi", and multi-word
 *      canonicals like "dera ghazi khan" beat the bare "khan"),
 *   4. bounded fuzzy match (Levenshtein) on the longest token — same initial
 *      letter, similar length, single unambiguous best — for real typos
 *      ("karachii", "kkarachi", "sialkott"),
 *   5. unresolved → keep the cleaned text (Title-cased) so nothing is lost.
 *
 * The canonical index is built once and cached (the seed rarely changes); a
 * per-string resolve cache keeps repeated lookups O(1).
 */
// Standalone tokens that are noise (province/country), not part of a city name.
const NOISE = new Set([
  'pakistan',
  'pak',
  'sindh',
  'punjab',
  'kpk',
  'khyber',
  'pakhtunkhwa',
  'balochistan',
  'baluchistan',
  'gilgit',
  'baltistan',
  'ajk',
  'kashmir',
]);

@Injectable()
export class CityCanonicalizerService {
  private readonly logger = new Logger(CityCanonicalizerService.name);
  private static readonly INDEX_KEY = 'city-canon-index-v1';
  private static readonly INDEX_TTL = 6 * 3600;
  private static readonly MAX_GRAM = 4;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Resolve many raw city strings at once. Returns a map keyed by the EXACT
   * input string → { key, display }, where `key` is the stable grouping key
   * (canonical name when matched, else the cleaned text) and `display` is the
   * Title-cased label to show.
   */
  async canonicalizeMany(
    raws: Iterable<string>,
  ): Promise<Map<string, { key: string; display: string }>> {
    const idx = await this.getIndex();
    const out = new Map<string, { key: string; display: string }>();
    for (const raw of raws) {
      if (out.has(raw)) continue;
      out.set(raw, this.resolve(raw, idx));
    }
    return out;
  }

  private resolve(raw: string, idx: CanonIndex): { key: string; display: string } {
    const cleaned = clean(raw);
    if (!cleaned) return { key: '', display: raw.trim() };

    const matched = this.match(cleaned, idx);
    if (matched) return { key: matched, display: titleCase(matched) };
    // Unresolved: group by the noise-stripped cleaned text so at least the
    // obvious junk ("... pakistan") collapses; display Title-cased.
    const stripped = stripNoise(cleaned) || cleaned;
    return { key: stripped, display: titleCase(stripped) };
  }

  private match(cleaned: string, idx: CanonIndex): string | null {
    // 1. exact
    if (idx.set.has(cleaned)) return cleaned;
    // 2. exact after noise strip
    const stripped = stripNoise(cleaned);
    if (stripped && stripped !== cleaned && idx.set.has(stripped)) return stripped;

    // 3. longest canonical n-gram present as whole words
    const tokens = (stripped || cleaned).split(' ').filter(Boolean);
    for (let n = Math.min(CityCanonicalizerService.MAX_GRAM, tokens.length); n >= 1; n--) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n).join(' ');
        // Skip 1-grams shorter than 4 chars to avoid matching noise like "kot".
        if (n === 1 && gram.length < 4) continue;
        if (idx.set.has(gram)) return gram;
      }
    }

    // 4. bounded fuzzy — ONLY for a single-token input that's a clear typo of a
    // ≥6-char city (e.g. "faisalbad", "bahawalour", "deraghazikhan"). Restricted
    // to single tokens because multi-word inputs are address fragments / names
    // ("Dr sarmad", "first floor near teen talwar") whose longest token lands on
    // a random similar city — a wrong merge corrupts a real city's stats, so
    // precision wins: anything not confidently a typo stays its own small row.
    if (tokens.length === 1 && tokens[0].length >= 6) {
      const fuzzy = this.fuzzy(tokens[0], idx);
      if (fuzzy) return fuzzy;
    }
    return null;
  }

  /**
   * Closest canonical to a ≥6-char token, guarded so it only accepts genuine
   * typos: same initial letter, a shared 3-char prefix (kills "Asad"→"Arad",
   * "Afshan"→"Ansan"), similar length, a tight length-scaled edit budget, and a
   * UNIQUE best (ties → no match). Anything not confidently a typo stays
   * unresolved (its own small row) rather than being mis-merged.
   */
  private fuzzy(token: string, idx: CanonIndex): string | null {
    const bucket = idx.byInitial.get(token[0]);
    if (!bucket) return null;
    const budget = token.length <= 8 ? 1 : 2;
    const prefix = token.slice(0, 3);
    let best: string | null = null;
    let bestD = budget + 1;
    let tie = false;
    for (const name of bucket) {
      if (Math.abs(name.length - token.length) > budget) continue;
      if (name.slice(0, 3) !== prefix) continue;
      const d = levenshtein(token, name, budget);
      if (d < bestD) {
        bestD = d;
        best = name;
        tie = false;
      } else if (d === bestD) {
        tie = true;
      }
    }
    return best && bestD <= budget && !tie ? best : null;
  }

  private async getIndex(): Promise<CanonIndex> {
    const cached = this.cache.get<CanonIndex>(CityCanonicalizerService.INDEX_KEY);
    if (cached) return cached;
    const rows = await this.prisma.courierCityMapping.findMany({
      where: { company_id: null },
      select: { city_name: true },
      distinct: ['city_name'],
    });
    const set = new Set<string>();
    const byInitial = new Map<string, string[]>();
    for (const r of rows) {
      const name = clean(r.city_name);
      if (!name) continue;
      set.add(name);
      const init = name[0];
      const arr = byInitial.get(init);
      if (arr) arr.push(name);
      else byInitial.set(init, [name]);
    }
    const idx: CanonIndex = { set, byInitial };
    this.cache.set(CityCanonicalizerService.INDEX_KEY, idx, CityCanonicalizerService.INDEX_TTL);
    this.logger.log(`Built canonical-city index: ${set.size} cities.`);
    return idx;
  }
}

interface CanonIndex {
  set: Set<string>;
  byInitial: Map<string, string[]>;
}

function clean(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNoise(cleaned: string): string {
  const kept = cleaned.split(' ').filter((t) => t && !NOISE.has(t));
  return kept.join(' ');
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Levenshtein with an early-exit budget: returns budget+1 the moment the best
 *  possible distance exceeds `max` (keeps the fuzzy pass cheap). */
function levenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}
