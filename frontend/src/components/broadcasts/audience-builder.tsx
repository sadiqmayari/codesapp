'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { Segment, SegmentFilter, ContactStatus } from '@/lib/crm-types';

export type AudienceMode = 'segment' | 'filter';
export interface AudienceValue {
  mode: AudienceMode;
  segmentId?: number;
  filter?: SegmentFilter;
}

const STATUSES: Array<ContactStatus | ''> = [
  '',
  'active',
  'blocked',
  'archived',
];

/**
 * Controlled audience picker. Emits either { segmentId } or { filter }.
 * The filter shape mirrors the backend SegmentFilterDto exactly (same one
 * used by the FE-2a segments drawer). Manual contact-id selection is not
 * offered (no contact-picker endpoint) — use a segment or filter.
 */
export function AudienceBuilder({
  value,
  onChange,
}: {
  value: AudienceValue;
  onChange: (v: AudienceValue) => void;
}) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    apiFetch<Segment[]>('/contacts/segments')
      .then(setSegments)
      .catch(() => setSegments([]));
  }, []);

  const f = value.filter ?? {};
  const setFilter = (patch: Partial<SegmentFilter>) =>
    onChange({ ...value, mode: 'filter', filter: { ...f, ...patch } });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['segment', 'filter'] as AudienceMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange({ mode: m })}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              value.mode === m
                ? 'bg-green-600 text-white'
                : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {m === 'segment' ? 'Saved segment' : 'Custom filter'}
          </button>
        ))}
      </div>

      {value.mode === 'segment' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Segment
          </label>
          <select
            value={value.segmentId ?? ''}
            onChange={(e) =>
              onChange({
                mode: 'segment',
                segmentId: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">Select a segment…</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {segments.length === 0 && (
            <p className="text-xs text-gray-400 mt-1">
              No segments yet — create one from the Contacts page, or use a
              custom filter.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Status
            </label>
            <select
              value={f.status ?? ''}
              onChange={(e) =>
                setFilter({
                  status: (e.target.value || undefined) as
                    | ContactStatus
                    | undefined,
                })
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === '' ? 'Any' : s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tags
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {(f.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() =>
                      setFilter({
                        tags: (f.tags ?? []).filter((x) => x !== t),
                      })
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const t = tagDraft.trim();
                  if (t && !(f.tags ?? []).includes(t))
                    setFilter({ tags: [...(f.tags ?? []), t] });
                  setTagDraft('');
                }
              }}
              placeholder="Add tag and press Enter"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last msg after
              </label>
              <input
                type="date"
                value={f.lastMessageAfter?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setFilter({
                    lastMessageAfter: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last msg before
              </label>
              <input
                type="date"
                value={f.lastMessageBefore?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setFilter({
                    lastMessageBefore: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={!!f.hasEmail}
              onChange={(e) =>
                setFilter({ hasEmail: e.target.checked || undefined })
              }
            />
            Has an email address
          </label>
        </div>
      )}
    </div>
  );
}
