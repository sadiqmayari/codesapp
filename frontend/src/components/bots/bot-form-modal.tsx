'use client';

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import type {
  Bot,
  BotAction,
  BotActionType,
  BotTriggerType,
  Template,
  TeamMember,
} from '@/lib/crm-types';

const ACTION_TYPES: Array<{ key: BotActionType; label: string }> = [
  { key: 'reply_template', label: 'Reply with template' },
  { key: 'send_text', label: 'Send text' },
  { key: 'assign_agent', label: 'Assign to agent' },
  { key: 'apply_tag', label: 'Apply tag' },
  { key: 'fire_webhook', label: 'Fire webhook' },
  { key: 'ai_reply', label: 'AI reply (auto)' },
];

function emptyAction(): BotAction {
  return { type: 'send_text', message: '' };
}

export function BotFormModal({
  open,
  onClose,
  onSaved,
  bot,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  bot?: Bot | null;
}) {
  const toast = useToast();
  const editing = !!bot;
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<BotTriggerType>('contains');
  const [keyword, setKeyword] = useState('');
  const [actions, setActions] = useState<BotAction[]>([emptyAction()]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiFetch<Template[]>('/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
    // Owner/admin only — agents 403 here; fall back to the numeric input.
    apiFetch<TeamMember[]>('/team')
      .then((r) => setMembers(Array.isArray(r) ? r : []))
      .catch(() => setMembers([]));
    setName(bot?.name ?? '');
    setTriggerType(bot?.trigger_type ?? 'contains');
    setKeyword(bot?.keyword ?? '');
    setActions(
      bot?.actions?.length ? bot.actions.map((a) => ({ ...a })) : [emptyAction()],
    );
  }, [open, bot]);

  const patchAction = (i: number, patch: Partial<BotAction>) =>
    setActions((c) => c.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const save = async () => {
    if (!name.trim()) return toast.error('Name is required');
    if (!keyword.trim()) return toast.error('Keyword is required');
    if (actions.length === 0) return toast.error('Add at least one action');

    // Strip empty optional fields per action type
    const cleaned: BotAction[] = actions.map((a) => {
      const base: BotAction = { type: a.type };
      if (a.type === 'reply_template') {
        base.templateId = a.templateId;
        if (a.variables && Object.keys(a.variables).length)
          base.variables = a.variables;
      } else if (a.type === 'send_text') base.message = a.message;
      else if (a.type === 'assign_agent') base.userId = a.userId;
      else if (a.type === 'apply_tag') base.tag = a.tag;
      else if (a.type === 'fire_webhook')
        base.webhookEndpointId = a.webhookEndpointId;
      return base;
    });

    // Validate required fields
    for (const a of cleaned) {
      if (a.type === 'reply_template' && !a.templateId)
        return toast.error('Pick a template for the reply-template action');
      if (a.type === 'send_text' && !a.message?.trim())
        return toast.error('Enter message text for the send-text action');
      if (a.type === 'assign_agent' && !a.userId)
        return toast.error('Enter an agent user ID');
      if (a.type === 'apply_tag' && !a.tag?.trim())
        return toast.error('Enter a tag');
      if (a.type === 'fire_webhook' && !a.webhookEndpointId)
        return toast.error('Enter a webhook endpoint ID');
    }

    const body = { name: name.trim(), triggerType, keyword: keyword.trim(), actions: cleaned };
    setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/bots/${bot!.id}`, { method: 'PATCH', body });
        toast.success('Bot updated');
      } else {
        await apiFetch('/bots', { method: 'POST', body });
        toast.success('Bot created');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save bot');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit bot' : 'New bot'}
      size="lg"
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create bot'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Trigger
            </label>
            <select
              value={triggerType}
              onChange={(e) =>
                setTriggerType(e.target.value as BotTriggerType)
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="exact">Exact match</option>
              <option value="contains">Contains</option>
              <option value="regex">Regex</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Keyword
            </label>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={triggerType === 'regex' ? '^hi.*' : 'hello'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700">
              Actions (run in order, 1–10)
            </label>
            {actions.length < 10 && (
              <button
                onClick={() => setActions((c) => [...c, emptyAction()])}
                className="text-sm text-green-600 hover:underline inline-flex items-center gap-1"
              >
                <Plus size={14} /> Add action
              </button>
            )}
          </div>
          <div className="space-y-3">
            {actions.map((a, i) => (
              <div
                key={i}
                className="border border-gray-200 rounded-lg p-3 space-y-2"
              >
                <div className="flex gap-2">
                  <select
                    value={a.type}
                    onChange={(e) =>
                      setActions((c) =>
                        c.map((x, j) =>
                          j === i
                            ? { type: e.target.value as BotActionType }
                            : x,
                        ),
                      )
                    }
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      setActions((c) =>
                        c.length === 1
                          ? [emptyAction()]
                          : c.filter((_, j) => j !== i),
                      )
                    }
                    className="px-3 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                  >
                    <X size={14} />
                  </button>
                </div>

                {a.type === 'reply_template' && (
                  <select
                    value={a.templateId ?? ''}
                    onChange={(e) =>
                      patchAction(i, {
                        templateId: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Select a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.status})
                      </option>
                    ))}
                  </select>
                )}
                {a.type === 'send_text' && (
                  <textarea
                    value={a.message ?? ''}
                    onChange={(e) =>
                      patchAction(i, { message: e.target.value })
                    }
                    rows={2}
                    placeholder="Message text"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                )}
                {a.type === 'assign_agent' &&
                  (members.length > 0 ? (
                    <select
                      value={a.userId ?? ''}
                      onChange={(e) =>
                        patchAction(i, {
                          userId: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Select an agent…</option>
                      {members
                        .filter(
                          (m) =>
                            m.status === 'active' || m.id === a.userId,
                        )
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} · {m.role}
                            {m.status !== 'active'
                              ? ` (${m.status})`
                              : ''}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div>
                      <input
                        type="number"
                        value={a.userId ?? ''}
                        onChange={(e) =>
                          patchAction(i, {
                            userId: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                        placeholder="Agent user ID"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        Team list unavailable — enter the numeric user ID.
                      </p>
                    </div>
                  ))}
                {a.type === 'apply_tag' && (
                  <input
                    value={a.tag ?? ''}
                    onChange={(e) => patchAction(i, { tag: e.target.value })}
                    placeholder="Tag to apply"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                )}
                {a.type === 'fire_webhook' && (
                  <div>
                    <input
                      type="number"
                      value={a.webhookEndpointId ?? ''}
                      onChange={(e) =>
                        patchAction(i, {
                          webhookEndpointId: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="Webhook endpoint ID"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Webhook management UI ships in FE-3 — enter the numeric
                      endpoint ID for now.
                    </p>
                  </div>
                )}
                {a.type === 'ai_reply' && (
                  <p className="text-xs text-gray-500 rounded-lg bg-violet-50 border border-violet-100 p-2">
                    When this keyword matches, the AI writes a grounded reply
                    and sends it automatically (within the 24-hour window),
                    handing off to a human if it&apos;s unsure. Requires AI in
                    your plan and enabled in Settings → AI.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
