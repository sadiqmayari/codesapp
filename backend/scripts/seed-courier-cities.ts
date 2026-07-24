/**
 * seed-courier-cities.ts
 *
 * Seeds the PLATFORM-DEFAULT city→courier-value lookup rows
 * (`courier_city_mappings` with `company_id IS NULL`) for all four couriers,
 * replacing the four hand-maintained lookup tabs the tenant kept in their
 * Google Sheet / n8n Data Tables.
 *
 * Source data (backend/scripts/data/*.json) was extracted from the tenant's
 * live n8n Data Table node output, NOT from the truncated Drive render:
 *   trax-cities.json      3831 rows  {city, code}
 *   leopards-cities.json   824 rows  {city, code}
 *   postex-cities.json     884 rows  ["CITY NAME", ...]   ← names only
 *   rocket-cities.json       8 rows  {city, code}
 *
 * IMPORTANT — PostEx has NO numeric city code. Its Data Table has a single
 * `City` column and its create-order API takes `cityName` (a NAME). So for
 * PostEx we store the courier's canonical CITY NAME in `city_code`. The
 * column therefore means "the value this courier expects for this city",
 * which is a numeric id for Trax/Leopards/Rocket and a name for PostEx.
 * This is why the app must still resolve PostEx through the mapping table:
 * not to translate to a code, but to validate the city is one PostEx
 * actually serves and to send PostEx's own spelling of it.
 *
 * Rocket serves only 8 cities. The tenant's n8n flow hardcoded Rocket's
 * city to "1024" for EVERY order — that is Karachi's code, so every
 * non-Karachi Rocket booking was sent with the wrong destination city.
 *
 * Idempotent: upserts by (company_id, courier_type, city_name), so re-runs
 * refresh codes without duplicating. Tenant-scoped override rows
 * (company_id = <id>) are never touched.
 *
 * Usage:
 *   npx ts-node backend/scripts/seed-courier-cities.ts            # dry run
 *   npx ts-node backend/scripts/seed-courier-cities.ts --apply
 */
import { PrismaClient, CourierType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DATA_DIR = path.join(__dirname, 'data');

interface CityRow {
  city: string;
  code: string;
}

function loadCoded(file: string): CityRow[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, file), 'utf8'),
  ) as CityRow[];
  return raw.filter((r) => r?.city?.trim() && String(r.code ?? '').trim());
}

/** PostEx: names only — the "code" we store IS the courier's city name. */
function loadNameOnly(file: string): CityRow[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, file), 'utf8'),
  ) as string[];
  return raw
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => ({ city: c, code: c.trim() }));
}

async function seedCourier(courierType: CourierType, rows: CityRow[]) {
  // Collapse duplicate normalized names (the source tables contain a few
  // case/spacing variants); first occurrence wins.
  const seen = new Map<string, string>();
  for (const r of rows) {
    const key = r.city.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, String(r.code).trim());
  }

  console.log(
    `${courierType}: ${rows.length} source rows → ${seen.size} unique cities`,
  );
  if (!APPLY) return { courierType, count: seen.size };

  let done = 0;
  for (const [cityName, cityCode] of seen) {
    await prisma.courierCityMapping.upsert({
      where: {
        company_id_courier_type_city_name: {
          company_id: null as unknown as number,
          courier_type: courierType,
          city_name: cityName,
        },
      },
      create: {
        company_id: null,
        courier_type: courierType,
        city_name: cityName,
        city_code: cityCode,
      },
      update: { city_code: cityCode },
    });
    if (++done % 500 === 0) console.log(`  …${done}/${seen.size}`);
  }
  console.log(`  ✓ ${courierType}: ${done} rows seeded`);
  return { courierType, count: done };
}

async function main() {
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply) ===');

  await seedCourier('trax', loadCoded('trax-cities.json'));
  await seedCourier('leopards', loadCoded('leopards-cities.json'));
  await seedCourier('postex', loadNameOnly('postex-cities.json'));
  await seedCourier('rocket', loadCoded('rocket-cities.json'));

  if (APPLY) {
    const total = await prisma.courierCityMapping.count({
      where: { company_id: null },
    });
    console.log(`\nPlatform-default city mappings now in DB: ${total}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
