'use client';

import { useMemo, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { WhatsAppPreview } from './whatsapp-preview';
import type {
  TemplateCategory,
  TemplateComponent,
} from '@/lib/crm-types';

const LANGS = ['en_US', 'en_GB', 'es_ES', 'pt_BR', 'fr_FR', 'ar', 'ur', 'hi'];
const NAME_RE = /^[a-z0-9_]+$/;

type HeaderType = 'none' | 'text' | 'image' | 'document';
type ButtonMode = 'none' | 'quick_reply' | 'call_to_action';

interface CtaButton {
  kind: 'url' | 'phone';
  text: string;
  value: string;
}

export function TemplateFormModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<TemplateCategory>('marketing');
  const [language, setLanguage] = useState('en_US');
  const [headerType, setHeaderType] = useState<HeaderType>('none');
  const [headerText, setHeaderText] = useState('');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [btnMode, setBtnMode] = useState<ButtonMode>('none');
  const [quickReplies, setQuickReplies] = useState<string[]>(['']);
  const [ctas, setCtas] = useState<CtaButton[]>([
    { kind: 'url', text: '', value: '' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const components = useMemo<TemplateComponent[]>(() => {
    const out: TemplateComponent[] = [];
    if (headerType === 'text' && headerText.trim())
      out.push({ type: 'HEADER', format: 'TEXT', text: headerText.trim() });
    else if (headerType === 'image')
      out.push({ type: 'HEADER', format: 'IMAGE' });
    else if (headerType === 'document')
      out.push({ type: 'HEADER', format: 'DOCUMENT' });
    out.push({ type: 'BODY', text: body });
    if (footer.trim()) out.push({ type: 'FOOTER', text: footer.trim() });
    if (btnMode === 'quick_reply') {
      const b = quickReplies
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3)
        .map((text) => ({ type: 'QUICK_REPLY' as const, text }));
      if (b.length) out.push({ type: 'BUTTONS', buttons: b });
    } else if (btnMode === 'call_to_action') {
      const b = ctas
        .filter((c) => c.text.trim() && c.value.trim())
        .slice(0, 2)
        .map((c) =>
          c.kind === 'url'
            ? { type: 'URL' as const, text: c.text.trim(), url: c.value.trim() }
            : {
                type: 'PHONE_NUMBER' as const,
                text: c.text.trim(),
                phone_number: c.value.trim(),
              },
        );
      if (b.length) out.push({ type: 'BUTTONS', buttons: b });
    }
    return out;
  }, [headerType, headerText, body, footer, btnMode, quickReplies, ctas]);

  const reset = () => {
    setName('');
    setCategory('marketing');
    setLanguage('en_US');
    setHeaderType('none');
    setHeaderText('');
    setBody('');
    setFooter('');
    setBtnMode('none');
    setQuickReplies(['']);
    setCtas([{ kind: 'url', text: '', value: '' }]);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!NAME_RE.test(name)) {
      toast.error('Name must be lowercase letters, numbers and underscores.');
      return;
    }
    if (!body.trim()) {
      toast.error('Body text is required.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/templates', {
        method: 'POST',
        body: { name, category, language, components },
      });
      toast.success('Template submitted to Meta for review');
      onCreated();
      close();
    } catch (e) {
      // 403 = WABA not configured OR plan template_limit reached.
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to create template',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New template"
      size="xl"
      footer={
        <>
          <button
            onClick={close}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit to Meta'}
          </button>
        </>
      }
    >
      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name *
            </label>
            <input
              value={name}
              onChange={(e) =>
                setName(e.target.value.toLowerCase().replace(/\s+/g, '_'))
              }
              placeholder="order_confirmation"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Lowercase letters, numbers and underscores only (Meta
              requirement).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as TemplateCategory)
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="marketing">Marketing</option>
                <option value="utility">Utility</option>
                <option value="authentication">Authentication</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Header
            </label>
            <select
              value={headerType}
              onChange={(e) => setHeaderType(e.target.value as HeaderType)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="none">None</option>
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="document">Document</option>
            </select>
            {headerType === 'text' && (
              <input
                value={headerText}
                onChange={(e) => setHeaderText(e.target.value)}
                placeholder="Header text"
                className="mt-2 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            )}
            {(headerType === 'image' || headerType === 'document') && (
              <p className="text-xs text-amber-600 mt-1">
                Media headers require a sample upload in Meta Business Manager —
                Meta may reject this until a sample is attached there.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Body *
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Hello {{1}}, your order {{2}} is confirmed."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Use {'{{1}}'}, {'{{2}}'} … for variables.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Footer
            </label>
            <input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Optional footer text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Buttons
            </label>
            <select
              value={btnMode}
              onChange={(e) => setBtnMode(e.target.value as ButtonMode)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="none">None</option>
              <option value="quick_reply">Quick reply (up to 3)</option>
              <option value="call_to_action">
                Call to action (up to 2)
              </option>
            </select>

            {btnMode === 'quick_reply' && (
              <div className="mt-2 space-y-2">
                {quickReplies.map((q, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={q}
                      onChange={(e) =>
                        setQuickReplies((c) =>
                          c.map((v, j) => (j === i ? e.target.value : v)),
                        )
                      }
                      placeholder={`Quick reply ${i + 1}`}
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <button
                      onClick={() =>
                        setQuickReplies((c) =>
                          c.length === 1
                            ? ['']
                            : c.filter((_, j) => j !== i),
                        )
                      }
                      className="px-3 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {quickReplies.length < 3 && (
                  <button
                    onClick={() => setQuickReplies((c) => [...c, ''])}
                    className="text-sm text-green-600 hover:underline inline-flex items-center gap-1"
                  >
                    <Plus size={14} /> Add quick reply
                  </button>
                )}
              </div>
            )}

            {btnMode === 'call_to_action' && (
              <div className="mt-2 space-y-2">
                {ctas.map((c, i) => (
                  <div key={i} className="space-y-2 border border-gray-200 rounded-lg p-2">
                    <div className="flex gap-2">
                      <select
                        value={c.kind}
                        onChange={(e) =>
                          setCtas((cur) =>
                            cur.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    kind: e.target.value as 'url' | 'phone',
                                  }
                                : x,
                            ),
                          )
                        }
                        className="border border-gray-300 rounded-lg px-2 py-2 text-sm"
                      >
                        <option value="url">URL</option>
                        <option value="phone">Phone</option>
                      </select>
                      <input
                        value={c.text}
                        onChange={(e) =>
                          setCtas((cur) =>
                            cur.map((x, j) =>
                              j === i ? { ...x, text: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="Button text"
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <input
                      value={c.value}
                      onChange={(e) =>
                        setCtas((cur) =>
                          cur.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder={
                        c.kind === 'url'
                          ? 'https://example.com'
                          : '+14155552671'
                      }
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                ))}
                {ctas.length < 2 && (
                  <button
                    onClick={() =>
                      setCtas((c) => [
                        ...c,
                        { kind: 'url', text: '', value: '' },
                      ])
                    }
                    className="text-sm text-green-600 hover:underline inline-flex items-center gap-1"
                  >
                    <Plus size={14} /> Add button
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Preview</p>
          <WhatsAppPreview components={components} />
        </div>
      </div>
    </Modal>
  );
}
