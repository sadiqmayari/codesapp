'use client';

import { useEffect, useState } from 'react';
import { Users, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { ContactPicker } from './contact-picker';
import type { Segment, SegmentFilter, ContactStatus } from '@/lib/crm-types';

export type AudienceMode = 'all' | 'segment' | 'filter' | 'contacts';
export interface AudienceValue {
  mode: AudienceMode;
  segmentId?: number;
  filter?: SegmentFilter;
  contactIds?: number[];
}

const STATUSES: Array<ContactStatus | ''> = ['', 'active', 'blocked', 'archived'];

const MODES: Array<{ key: AudienceMode; label: string }> = [
  { key: 'all', label: 'All contacts' },
  { key: 'segment', label: 'Saved segment' },
  { key: 'filter', label: 'Custom filter' },
  { key: 'contacts', label: 'Pick contacts' },
];

/**
 * Controlled audience picker with four modes. Emits one of:
 *   { mode:'all' } | { segmentId } | { filter } | { contactIds }
 * The filter shape mirrors the backend SegmentFilterDto.
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
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange({ mode: m.key })}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              value.mode === m.key
                ? 'bg-green-600 text-white'
                : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {value.mode === 'all' ? (
        <div className="flex items-start gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-3">
          <Users size={16} className="text-green-600 mt-0.5 shrink-0" />
          <p className="text-sm text-green-800">
            Every <span className="font-medium">active</span> contact in your
            account will receive this campaign. Blocked and archived contacts
            are skipped automatically.
          </p>
        </div>
      ) : value.mode === 'contacts' ? (
        <ContactPicker
          value={value.contactIds ?? []}
          onChange={(ids) => onChange({ mode: 'contacts', contactIds: ids })}
        />
      ) : value.mode === 'segment' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Segment
          </label>
          <select
            value={value.segmentId ?? ''}
            onChange={(e) =>
              onChange({
                mode: 'segment',
                segmentId: e.target.value ? Number(e.target.value) : undefined,
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
              custom filter / pick contacts.
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
