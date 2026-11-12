// Deterministic avatar colour + initials (Inbox-v2: list rows, thread header,
// contact drawer). Colours are dark enough for white text (AA).
const AVATAR_COLORS = [
  'bg-teal-700',
  'bg-amber-700',
  'bg-indigo-700',
  'bg-green-700',
  'bg-purple-700',
  'bg-rose-700',
  'bg-sky-700',
  'bg-slate-600',
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ASCII punctuation + symbol/emoji ranges → word breaks. Letters of any script
// (Urdu, Arabic, …) and digits are kept.
const NOISE = /[!-/:-@[-`{-~ -⯿\uD800-\uDFFF️]/g;

export function initialsOf(name: string): string {
  const parts = name.replace(NOISE, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '#';
  if (/^\d/.test(parts[0])) return parts[0].slice(-2);
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? '' : '';
  return (first + last).toUpperCase();
}
