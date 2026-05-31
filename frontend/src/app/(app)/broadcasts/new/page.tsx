'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Send,
  Users,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  AudienceBuilder,
  type AudienceValue,
} from '@/components/broadcasts/audience-builder';
import { TemplatePreview } from '@/components/broadcasts/template-preview';
import {
  extractPlaceholders,
  parseToken,
  tokenFor,
  type FieldKind,
} from '@/lib/broadcast-utils';
import { cn } from '@/lib/utils';
import type {
  AudiencePreview,
  Broadcast,
  Template,
} from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const STEPS = ['Details', 'Audience', 'Personalize', 'Review'] as const;
type StepIdx = 0 | 1 | 2 | 3;

const FIELD_OPTIONS: Array<{ value: FieldKind; label: string }> = [
  { value: 'text', label: 'Custom text' },
  { value: 'name', label: 'Contact name' },
  { value: 'phone', label: 'Contact phone' },
  { value: 'email', label: 'Contact email' },
  { value: 'custom', label: 'Custom field' },
];

/** Map the audience UI value → the API audience fields. */
function audienceBody(a: AudienceValue): Record<string, unknown> {
  if (a.mode === 'all') return { all: true };
  if (a.mode === 'segment')
    return a.segmentId ? { segmentId: a.segmentId } : {};
  if (a.mode === 'filter') return a.filter ? { filter: a.filter } : {};
  if (a.mode === 'contacts')
    return a.contactIds?.length ? { contactIds: a.contactIds } : {};
  return {};
}

function audienceValid(a: AudienceValue): boolean {
  if (a.mode === 'all') return true;
  if (a.mode === 'segment') return !!a.segmentId;
  if (a.mode === 'filter') return !!a.filter && Object.keys(a.filter).length > 0;
  if (a.mode === 'contacts') return (a.contactIds?.length ?? 0) > 0;
  return false;
}

export default function BroadcastWizardPage() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<StepIdx>(0);
  const [editId, setEditId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [audience, setAudience] = useState<AudienceValue>({ mode: 'all' });
  const [vars, setVars] = useState<Record<string, string>>({});

  // Live audience count.
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Test send.
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);

  // Schedule.
  const [scheduleAt, setScheduleAt] = useState('');

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );
  const placeholders = useMemo(
    () => (template ? extractPlaceholders(template) : []),
    [template],
  );

  // Load templates + (when editing) the existing broadcast.
  useEffect(() => {
    const idParam = new URLSearchParams(window.location.search).get('id');
    const id = idParam ? Number(idParam) : null;
    setEditId(id);
    (async () => {
      try {
        const tpls = await apiFetch<Template[]>('/templates');
        setTemplates(tpls);
        if (id) {
          const b = await apiFetch<Broadcast>(`/broadcasts/${id}`);
          setName(b.name);
          setTemplateId(b.template_id);
          const a = b.audience_filter ?? {};
          if (a.all) setAudience({ mode: 'all' });
          else if (a.contactIds?.length)
            setAudience({ mode: 'contacts', contactIds: a.contactIds });
          else if (a.segmentId)
            setAudience({ mode: 'segment', segmentId: a.segmentId });
          else if (a.filter) setAudience({ mode: 'filter', filter: a.filter });
          else setAudience({ mode: 'all' });
          setVars(a.variables ?? {});
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  // Keep the variable map in sync with the template's placeholders.
  useEffect(() => {
    setVars((cur) => {
      const next: Record<string, string> = {};
      for (const n of placeholders) next[String(n)] = cur[String(n)] ?? '';
      return next;
    });
  }, [placeholders]);

  // Debounced live audience count whenever the audience changes.
  const refreshPreview = useCallback((a: AudienceValue) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!audienceValid(a)) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch<AudiencePreview>(
          '/broadcasts/preview-audience',
          { method: 'POST', body: audienceBody(a) },
        );
        setPreview(res);
      } catch {
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    }, 400);
  }, []);

  useEffect(() => {
    refreshPreview(audience);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [audience, refreshPreview]);

  const personalizationComplete = useMemo(() => {
    return placeholders.every((n) => {
      const raw = vars[String(n)] ?? '';
      const { kind, customKey } = parseToken(raw);
      if (kind === 'custom') return customKey.trim().length > 0;
      if (kind === 'text') return raw.trim().length > 0;
      return true; // name/phone/email
    });
  }, [placeholders, vars]);

  const setVar = (n: number, value: string) =>
    setVars((c) => ({ ...c, [String(n)]: value }));

  const setKind = (n: number, kind: FieldKind) => {
    if (kind === 'text') setVar(n, '');
    else if (kind === 'custom') {
      const { customKey } = parseToken(vars[String(n)] ?? '');
      setVar(n, tokenFor('custom', customKey));
    } else setVar(n, tokenFor(kind));
  };

  // ---- step gating ----
  const stepError = (s: StepIdx): string | null => {
    if (s === 0) {
      if (!name.trim()) return 'Give the campaign a name';
      if (!templateId) return 'Pick a template';
    }
    if (s === 1 && !audienceValid(audience))
      return 'Choose a valid audience';
    if (s === 2 && !personalizationComplete)
      return 'Fill in every template variable';
    return null;
  };

  const next = () => {
    const err = stepError(step);
    if (err) {
      toast.error(err);
      return;
    }
    setStep((s) => Math.min(3, s + 1) as StepIdx);
  };
  const back = () => setStep((s) => Math.max(0, s - 1) as StepIdx);

  const buildBody = () => ({
    name: name.trim(),
    templateId: Number(templateId),
    ...audienceBody(audience),
    ...(Object.keys(vars).length ? { variables: vars } : {}),
  });

  const persistDraft = async (): Promise<number | null> => {
    const body = buildBody();
    if (editId) {
      await apiFetch(`/broadcasts/${editId}`, { method: 'PATCH', body });
      return editId;
    }
    const created = await apiFetch<Broadcast>('/broadcasts', {
      method: 'POST',
      body,
    });
    setEditId(created.id);
    return created.id;
  };

  const onSaveDraft = async () => {
    setSaving(true);
    try {
      await persistDraft();
      toast.success(editId ? 'Draft updated' : 'Draft saved');
      router.push('/broadcasts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onSendNow = async () => {
    setSaving(true);
    try {
      const id = await persistDraft();
      if (id) await apiFetch(`/broadcasts/${id}/send`, { method: 'POST' });
      toast.success('Broadcast sending');
      router.push('/broadcasts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Send failed');
    } finally {
      setSaving(false);
    }
  };

  const onSchedule = async () => {
    if (!scheduleAt) {
      toast.error('Pick a date & time');
      return;
    }
    const iso = new Date(scheduleAt).toISOString();
    if (new Date(iso).getTime() <= Date.now()) {
      toast.error('Pick a future date & time');
      return;
    }
    setSaving(true);
    try {
      const id = await persistDraft();
      if (id)
        await apiFetch(`/broadcasts/${id}/schedule`, {
          method: 'POST',
          body: { runAt: iso },
        });
      toast.success('Broadcast scheduled');
      router.push('/broadcasts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Schedule failed');
    } finally {
      setSaving(false);
    }
  };

  const onTestSend = async () => {
    if (!testPhone.trim()) {
      toast.error('Enter a phone number to test');
      return;
    }
    if (!templateId) {
      toast.error('Pick a template first');
      return;
    }
    setTesting(true);
    try {
      await apiFetch('/broadcasts/test-send', {
        method: 'POST',
        body: {
          templateId: Number(templateId),
          phone: testPhone.trim(),
          variables: vars,
        },
      });
      toast.success(`Test sent to ${testPhone.trim()}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Test send failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-400">Loading…</div>;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <button
        onClick={() => router.push('/broadcasts')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-4"
      >
        <ArrowLeft size={16} /> Broadcasts
      </button>
      <h1 className="text-2xl font-bold text-gray-900 mb-5">
        {editId ? 'Edit campaign' : 'New campaign'}
      </h1>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => i < step && setStep(i as StepIdx)}
            className="flex items-center gap-2"
          >
            <span
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold',
                i < step
                  ? 'bg-green-600 text-white'
                  : i === step
                    ? 'bg-green-600 text-white ring-4 ring-green-100'
                    : 'bg-gray-200 text-gray-500',
              )}
            >
              {i < step ? <Check size={14} /> : i + 1}
            </span>
            <span
              className={cn(
                'text-sm hidden sm:inline',
                i === step ? 'font-semibold text-gray-900' : 'text-gray-500',
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="w-6 sm:w-10 h-px bg-gray-200" />
            )}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_22rem] gap-6">
        <div className="space-y-6">
          {/* STEP 0 — details */}
          {step === 0 && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Campaign name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. October promo"
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
                {template && template.status !== 'approved' && (
                  <p className="text-xs text-amber-600 mt-1">
                    This template is <b>{template.status}</b> — it may fail to
                    send until Meta approves it.
                  </p>
                )}
              </div>
            </>
          )}

          {/* STEP 1 — audience */}
          {step === 1 && (
            <>
              <AudienceBuilder value={audience} onChange={setAudience} />
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm">
                <Users size={16} className="text-green-600" />
                {previewing ? (
                  <span className="text-gray-500 inline-flex items-center gap-1.5">
                    <Loader2 size={14} className="animate-spin" /> Counting…
                  </span>
                ) : preview ? (
                  <span className="text-gray-700">
                    This campaign will reach{' '}
                    <span className="font-semibold text-gray-900">
                      {preview.count}
                    </span>{' '}
                    contact{preview.count === 1 ? '' : 's'}.
                    {preview.sample.length > 0 && (
                      <span className="text-gray-400">
                        {' '}
                        e.g.{' '}
                        {preview.sample
                          .slice(0, 3)
                          .map((c) => c.name || c.phone)
                          .join(', ')}
                        {preview.count > 3 ? '…' : ''}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-gray-400">
                    Choose an audience to see how many contacts it reaches.
                  </span>
                )}
              </div>
            </>
          )}

          {/* STEP 2 — personalize */}
          {step === 2 && (
            <div className="space-y-4">
              {placeholders.length === 0 ? (
                <p className="text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg px-3 py-4">
                  This template has no variables — nothing to personalize.
                </p>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    Map each template variable to a fixed value or a contact
                    field. Contact fields are filled in per recipient.
                  </p>
                  {placeholders.map((n) => {
                    const raw = vars[String(n)] ?? '';
                    const { kind, customKey } = parseToken(raw);
                    return (
                      <div
                        key={n}
                        className="rounded-lg border border-gray-200 p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-600">
                            {`{{${n}}}`}
                          </span>
                          <select
                            value={kind}
                            onChange={(e) =>
                              setKind(n, e.target.value as FieldKind)
                            }
                            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          >
                            {FIELD_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {kind === 'text' && (
                          <input
                            value={raw}
                            onChange={(e) => setVar(n, e.target.value)}
                            placeholder="Fixed text for everyone"
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          />
                        )}
                        {kind === 'custom' && (
                          <input
                            value={customKey}
                            onChange={(e) =>
                              setVar(n, tokenFor('custom', e.target.value))
                            }
                            placeholder="custom field key, e.g. order_id"
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {/* Test send */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                <p className="text-sm font-medium text-gray-700">
                  Test this message
                </p>
                <p className="text-xs text-gray-400">
                  Send one real message to your own WhatsApp number to preview
                  it. Doesn&apos;t affect campaign stats.
                </p>
                <div className="flex gap-2">
                  <input
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    placeholder="+92300…"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    type="button"
                    onClick={onTestSend}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 text-green-700 px-3 py-2 text-sm hover:bg-green-50 disabled:opacity-50"
                  >
                    {testing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    Send test
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3 — review */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 divide-y divide-gray-100">
                <Row label="Campaign">{name}</Row>
                <Row label="Template">
                  {template?.name}{' '}
                  <span className="text-gray-400">({template?.status})</span>
                </Row>
                <Row label="Audience">
                  {previewing ? (
                    'Counting…'
                  ) : (
                    <span className="font-medium text-gray-900">
                      {preview?.count ?? 0} contact
                      {(preview?.count ?? 0) === 1 ? '' : 's'}
                    </span>
                  )}
                </Row>
                <Row label="Personalization">
                  {placeholders.length === 0
                    ? 'None'
                    : `${placeholders.length} variable${placeholders.length === 1 ? '' : 's'} mapped`}
                </Row>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Schedule (optional)
                </label>
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Leave empty to send immediately. Uses your local timezone.
                </p>
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
                <button
                  onClick={onSaveDraft}
                  disabled={saving}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Save draft
                </button>
                {scheduleAt ? (
                  <button
                    onClick={onSchedule}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : null}
                    Schedule campaign
                  </button>
                ) : (
                  <button
                    onClick={onSendNow}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Send size={15} />
                    )}
                    Send now
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Nav buttons (steps 0–2) */}
          {step < 3 && (
            <div className="flex justify-between pt-2 border-t border-gray-200">
              <button
                onClick={back}
                disabled={step === 0}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                Back
              </button>
              <button
                onClick={next}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium"
              >
                Continue <ArrowRight size={15} />
              </button>
            </div>
          )}
        </div>

        {/* Live preview rail */}
        <div className="lg:sticky lg:top-4 self-start">
          <p className="text-xs font-medium text-gray-500 mb-2">Preview</p>
          <TemplatePreview template={template} variables={vars} />
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-800 text-right">{children}</span>
    </div>
  );
}
