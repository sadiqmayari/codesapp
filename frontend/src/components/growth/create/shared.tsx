'use client';

import { useCallback, useMemo, useRef } from 'react';
import { growthManageApi } from '@/lib/growth-manage';

export type BuilderPlatform = 'meta' | 'google' | 'tiktok';

/**
 * One autosaved draft per user is kept server-side (ad_drafts). The three
 * builders share it: each owns one key ('meta' | 'google' | 'tiktok') and a save
 * merges into the rest, so switching platform never loses another draft.
 * Legacy payloads (Meta only) were `{ accountId, draft }` at the top level.
 */
export interface DraftStore {
  get(key: BuilderPlatform): unknown;
  save(key: BuilderPlatform, value: unknown | null): Promise<void>;
}

export interface BuilderProps {
  accounts: Array<{ id: number; name: string | null }>;
  store: DraftStore;
}

type Payload = Partial<Record<BuilderPlatform, unknown>> & { platform?: BuilderPlatform };

export function normalisePayload(raw: Record<string, unknown> | null | undefined): Payload {
  if (!raw) return {};
  const out: Payload = {};
  for (const k of ['meta', 'google', 'tiktok'] as const) if (raw[k] != null) out[k] = raw[k];
  if (!out.meta && (raw.accountId != null || raw.draft != null)) out.meta = { accountId: raw.accountId, draft: raw.draft };
  if (raw.platform === 'meta' || raw.platform === 'google' || raw.platform === 'tiktok') out.platform = raw.platform;
  return out;
}

export function useDraftStore(initial: Record<string, unknown> | null | undefined, platform: BuilderPlatform): DraftStore {
  const ref = useRef<Payload>(normalisePayload(initial));
  // Keep the last-used platform so the page reopens on it.
  ref.current.platform = platform;
  const get = useCallback((key: BuilderPlatform) => ref.current[key], []);
  const save = useCallback(async (key: BuilderPlatform, value: unknown | null) => {
    if (value == null) delete ref.current[key];
    else ref.current[key] = value;
    const { platform: p, ...rest } = ref.current;
    const empty = !Object.keys(rest).length;
    await growthManageApi.saveDraft(empty ? null : ({ ...rest, platform: p } as Record<string, unknown>));
  }, []);
  return useMemo(() => ({ get, save }), [get, save]);
}

/** Final-URL check the builders show before publish. */
export const isUrl = (v: string | null | undefined) => /^https?:\/\/[^\s.]+\.[^\s]+/i.test((v ?? '').trim());
