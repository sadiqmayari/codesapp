'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

// Shell-Polish-C: rich inbound URL preview card.
// Best-effort end to end — if the backend returns ok:false, the fetch throws,
// or there is no title-and-no-image, this renders NOTHING (the autolinked
// bare URL in the bubble text is sufficient). Never toasts.

interface OgData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetched_at: string;
  ok: boolean;
}

// Render-side dedup on top of the backend cache: the same URL appearing in
// two visible messages fires only one network call.
const inflight = new Map<string, Promise<OgData | null>>();

function load(url: string): Promise<OgData | null> {
  const existing = inflight.get(url);
  if (existing) return existing;
  const p = apiFetch<OgData>('og', { params: { url } })
    .then((d) => d)
    .catch(() => null);
  inflight.set(url, p);
  return p;
}

export default function OgPreviewCard({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | OgData | null>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    load(url).then((d) => {
      if (alive) setState(d);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (state === 'loading') {
    return (
      <div className="mt-1 max-w-[260px] rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <div className="truncate text-xs text-gray-400">{url}</div>
      </div>
    );
  }

  if (!state || !state.ok) return null;
  const hasContent = !!(state.title || state.image);
  if (!hasContent) return null;

  return (
    <a
      href={state.url || url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="mt-1 flex max-w-[300px] gap-2 overflow-hidden rounded-lg border border-gray-200 bg-white p-2 no-underline hover:bg-gray-50"
    >
      {state.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={state.image}
          alt=""
          loading="lazy"
          className="h-24 w-24 flex-shrink-0 rounded-md object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        {state.title && (
          <div className="truncate text-sm font-semibold text-gray-900">
            {state.title}
          </div>
        )}
        {state.description && (
          <div className="mt-0.5 line-clamp-2 text-xs text-gray-600">
            {state.description}
          </div>
        )}
        {state.site_name && (
          <div className="mt-1 truncate text-[10px] uppercase tracking-wide text-gray-400">
            {state.site_name}
          </div>
        )}
      </div>
    </a>
  );
}
