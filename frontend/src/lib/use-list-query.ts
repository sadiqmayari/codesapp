'use client';

/**
 * Search & filter conventions — the shared list-state hooks.
 *
 *  - `useUrlFilters(defaults)`  — filter/search/page state that lives in the
 *    URL query (refresh, Back and shared links restore the exact view). Only
 *    NON-default values are written, other params (e.g. `?view=`) are kept.
 *    Reads `window.location.search` once on mount (the Contacts pattern), so no
 *    Suspense boundary is needed.
 *  - `useDebouncedValue(v, ms)` — search-as-you-type debounce (default 300ms).
 *  - `useLatestRequest()`       — run a fetch so a superseded one is ABORTED and
 *    its late response can never overwrite newer state.
 *
 * See CLAUDE.md "Search & filter conventions". Never hand-roll another
 * debounce / request-seq guard in a page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isAbortError } from './api';

export type FilterValues = Record<string, string>;

export function useUrlFilters<T extends FilterValues>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  // Defaults are captured once (callers pass an object literal each render).
  const defaultsRef = useRef(defaults);
  const [values, setValues] = useState<T>(defaults);
  const [ready, setReady] = useState(false);

  // Hydrate from the URL once.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const next = { ...defaultsRef.current };
    for (const k of Object.keys(next) as (keyof T)[]) {
      const v = sp.get(k as string);
      if (v != null) next[k] = v as T[keyof T];
    }
    setValues(next);
    setReady(true);
  }, []);

  // Mirror to the URL (replace, no scroll) whenever values change after hydrate.
  useEffect(() => {
    if (!ready) return;
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(values)) {
      if (v && v !== defaultsRef.current[k]) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    const next = `${pathname}${qs ? `?${qs}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      router.replace(next, { scroll: false });
    }
    // router deliberately omitted (Next 14 wrapper identity is unstable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, ready, pathname]);

  /**
   * Patch one or more values. Any change to a key other than `page` resets
   * `page` to its default (so a new filter never lands on an empty page 7).
   */
  const set = useCallback((patch: Partial<T>) => {
    setValues((prev) => {
      const next = { ...prev, ...patch };
      const changed = Object.keys(patch).some((k) => k !== 'page' && prev[k] !== patch[k]);
      if (changed && 'page' in defaultsRef.current && !('page' in patch)) {
        (next as FilterValues).page = defaultsRef.current.page;
      }
      return next;
    });
  }, []);

  /** Reset every key except the ones listed in `keep` (e.g. a lane/tab). */
  const clearAll = useCallback((keep: (keyof T)[] = []) => {
    setValues((prev) => {
      const next = { ...defaultsRef.current };
      for (const k of keep) next[k] = prev[k];
      return next;
    });
  }, []);

  /** Number of keys (other than `page` and `keep`) set to a non-default value. */
  const activeCount = useCallback(
    (ignore: (keyof T)[] = []) =>
      Object.keys(values).filter(
        (k) => k !== 'page' && !ignore.includes(k) && values[k] && values[k] !== defaultsRef.current[k],
      ).length,
    [values],
  );

  return { values, set, clearAll, activeCount, ready, defaults: defaultsRef.current };
}

export function useDebouncedValue<V>(value: V, ms = 300): V {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * `const run = useLatestRequest();`
 * `const data = await run((signal) => apiFetch(url, { signal }));`
 * Resolves `undefined` when the call was superseded (aborted or a newer call
 * started) — callers just `if (data === undefined) return;`. Real errors still
 * throw.
 */
export function useLatestRequest() {
  const ctrl = useRef<AbortController | null>(null);
  const seq = useRef(0);
  useEffect(() => () => ctrl.current?.abort(), []);
  return useMemo(
    () =>
      async function run<R>(fn: (signal: AbortSignal) => Promise<R>): Promise<R | undefined> {
        ctrl.current?.abort();
        const c = new AbortController();
        ctrl.current = c;
        const my = ++seq.current;
        try {
          const r = await fn(c.signal);
          return my === seq.current ? r : undefined;
        } catch (e) {
          if (isAbortError(e) || my !== seq.current) return undefined;
          throw e;
        }
      },
    [],
  );
}

/**
 * Debounced search box bound to a URL filter value.
 * `const [input, setInput] = useSearchBox(values.q, ready, (q) => set({ q }));`
 *  - seeds the box from the URL after hydrate,
 *  - commits trimmed typing to the URL after `ms`,
 *  - follows EXTERNAL changes (Clear all, removing the pill, Back) without the
 *    stale debounced value bouncing them back.
 */
export function useSearchBox(
  urlValue: string,
  ready: boolean,
  commit: (v: string) => void,
  ms = 300,
): [string, (v: string) => void] {
  const [input, setInput] = useState(urlValue);
  const typed = useRef(false);
  const lastCommitted = useRef<string | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!ready) return;
    if (urlValue !== lastCommitted.current) {
      lastCommitted.current = urlValue;
      setInput(urlValue);
      typed.current = false;
    }
  }, [urlValue, ready]);

  const debounced = useDebouncedValue(input, ms);
  useEffect(() => {
    if (!ready || !typed.current) return;
    const t = debounced.trim();
    if (t !== lastCommitted.current) {
      lastCommitted.current = t;
      commitRef.current(t);
    }
  }, [debounced, ready]);

  const onChange = useCallback((v: string) => {
    typed.current = true;
    setInput(v);
  }, []);
  return [input, onChange];
}
