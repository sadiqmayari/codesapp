/** CSV helpers for inventory exports: quoted when needed + formula-injection safe + BOM. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Neutralise spreadsheet formulas (=, +, -, @, tab, CR) unless it's a plain number.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
