'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  AudienceBuilder,
  type AudienceValue,
} from '@/components/broadcasts/audience-builder';
import type { Broadcast, Template } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

interface VarRow {
  key: string;
  value: string;
}

export default function BroadcastNewPage() {
  const router = useRouter();
  const toast = useToast();

  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [audience, setAudience] = useState<AudienceValue>({ mode: 'segment' });
  const [vars, setVars] = useState<VarRow[]>([{ key: '1', value: '' }]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const idParam = new URLSearchParams(window.location.search).get('id');
    const id = idParam ? Number(idParam) : null;
    setEditId(id);

    const init = async () => {
      try {
        const tpls = await apiFetch<Template[]>('/templates');
        setTemplates(tpls);
        if (id) {
          const b = await apiFetch<Broadcast>(`/broadcasts/${id}`);
          setName(b.name);
          setTemplateId(b.template_id);
          const a = b.audience_filter ?? {};
          if (a.segmentId)
            setAudience({ mode: 'segment', segmentId: a.segmentId });
          else if (a.filter)
            setAudience({ mode: 'filter', filter: a.filter });
          else setAudience({ mode: 'segment' });
          const v = a.variables ?? {};
          const rows = Object.entries(v).map(([key, value]) => ({
            key,
            value: String(value),
          }));
          setVars(rows.length ? rows : [{ key: '1', value: '' }]);
        }
      } catch (e) {
        toast.error(
          e instanceof ApiError ? e.userMessage : 'Failed to load',
        );
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [toast]);

  const buildBody = () => {
    const variables: Record<string, string> = {};
    for (const { key, value } of vars) {
      const k = key.trim();
      if (k) variables[k] = value;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      templateId: Number(templateId),
    };
    if (Object.keys(variables).length) body.variables = variables;
    if (audience.mode === 'segment') {
      if (audience.segmentId) body.segmentId = audience.segmentId;
    } else if (audience.filter) {
      body.filter = audience.filter;
    }
    return body;
  };

  const validate = (): string | null => {
    if (!name.trim()) return 'Name is required';
    if (!templateId) return 'Pick a template';
    if (audience.mode === 'segment' && !audience.segmentId)
      return 'Select a segment (or switch to a custom filter)';
    if (
      audience.mode === 'filter' &&
      (!audience.filter || Object.keys(audience.filter).length === 0)
    )
      return 'Add at least one filter criterion';
    return null;
  };

  const save = async (thenSend: boolean) => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      let id = editId;
      if (editId) {
        await apiFetch(`/broadcasts/${editId}`, {
          method: 'PATCH',
          body: buildBody(),
        });
      } else {
        const created = await apiFetch<Broadcast>('/broadcasts', {
          method: 'POST',
          body: buildBody(),
        });
        id = created.id;
      }
      if (thenSend && id) {
        await apiFetch(`/broadcasts/${id}/send`, { method: 'POST' });
        toast.success('Broadcast sending');
      } else {
        toast.success(editId ? 'Draft updated' : 'Draft saved');
      }
      router.push('/broadcasts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return <div className="p-6 text-gray-400">Loading…</div>;

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <button
        onClick={() => router.push('/broadcasts')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-4"
      >
        <ArrowLeft size={16} /> Broadcasts
      </button>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {editId ? 'Edit broadcast' : 'New broadcast'}
      </h1>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Template
          </label>
          <select
            value={templateId}
            onChange={(e) =>
              setTemplateId(e.target.value ? Number(e.target.value) : '')
            }
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">Select a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.status})
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            Only approved templates will actually send (Meta requirement).
          </p>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Audience</p>
          <AudienceBuilder value={audience} onChange={setAudience} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Template variables
          </label>
          <p className="text-xs text-gray-400 mb-2">
            Map placeholder numbers to values, e.g. key <code>1</code> →
            value for {'{{1}}'}.
          </p>
          <div className="space-y-2">
            {vars.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.key}
                  onChange={(e) =>
                    setVars((c) =>
                      c.map((r, j) =>
                        j === i ? { ...r, key: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="1"
                  className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <input
                  value={row.value}
                  onChange={(e) =>
                    setVars((c) =>
                      c.map((r, j) =>
                        j === i ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="value"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <button
                  onClick={() =>
                    setVars((c) =>
                      c.length === 1
                        ? [{ key: '1', value: '' }]
                        : c.filter((_, j) => j !== i),
                    )
                  }
                  className="px-3 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() =>
              setVars((c) => [
                ...c,
                { key: String(c.length + 1), value: '' },
              ])
            }
            className="mt-2 text-sm text-green-600 hover:underline inline-flex items-center gap-1"
          >
            <Plus size={14} /> Add variable
          </button>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
          <button
            onClick={() => save(false)}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
          >
            Save &amp; send now
          </button>
        </div>
      </div>
    </div>
  );
}
