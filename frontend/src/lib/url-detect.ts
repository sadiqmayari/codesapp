// Shell-Polish-C: single source of truth for URL detection in message text.
// Conservative http(s)-only matcher; ASCII host + path/query/fragment.
// Trailing punctuation that is almost always sentence punctuation (not part
// of the URL) is trimmed off.

const MAX_URLS = 3; // rendering 10 preview cards = spam

// Fresh regex per scan — global regexes carry mutable lastIndex state.
function matcher(): RegExp {
  return /https?:\/\/[^\s<>"']+/gi;
}

function trimTrailing(u: string): string {
  // Drop trailing sentence punctuation; keep a balanced ")".
  let out = u.replace(/[.,;:!?]+$/, '');
  if (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1);
  return out;
}

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'url'; value: string };

/** Unique URLs in order of first appearance, capped at 3. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = matcher();
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const u = trimTrailing(m[0]);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
      if (out.length >= MAX_URLS) break;
    }
  }
  return out;
}

/** Split text into renderable text/url segments (same matcher as above). */
export function autolinkText(text: string): Segment[] {
  if (!text) return [];
  const re = matcher();
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const start = m.index;
    const url = trimTrailing(raw);
    if (start > last) {
      segments.push({ kind: 'text', value: text.slice(last, start) });
    }
    segments.push({ kind: 'url', value: url });
    // any trailing punctuation we trimmed off stays as text
    const tail = raw.slice(url.length);
    if (tail) segments.push({ kind: 'text', value: tail });
    last = start + raw.length;
  }
  if (last < text.length) {
    segments.push({ kind: 'text', value: text.slice(last) });
  }
  return segments;
}
