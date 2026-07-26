'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  X,
  Plus,
  Pencil,
  Trash2,
  Ban,
  Archive,
  CheckCircle2,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/modal';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import type { Contact, ContactStatus } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

function StatusPill({ status }: { status: ContactStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'active' && 'bg-green-100 text-green-800',
        status === 'blocked' && 'bg-red-100 text-red-800',
        status === 'archived' && 'bg-gray-200 text-gray-700',
      )}
    >
      {status}
    </span>
  );
}

export default function ContactProfilePage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = Number(params?.id);

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [tagDraft, setTagDraft] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cfEditing, setCfEditing] = useState(false);
  const [cfRows, setCfRows] = useState<Array<{ key: string; value: string }>>(
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await apiFetch<Contact>(`/contacts/${id}`);
      setContact(c);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else
        toast.error(
          e instanceof ApiError ? e.userMessage : 'Failed to load contact',
        );
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    if (Number.isFinite(id)) load();
  }, [id, load]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    try {
      const updated = await apiFetch<Contact>(`/contacts/${id}`, {
        method: 'PATCH',
        body,
      });
      setContact(updated);
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    }
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (!contact || !t || contact.tags.includes(t)) {
      setTagDraft('');
      return;
    }
    patch({ tags: [...contact.tags, t] }, 'Tag added');
    setTagDraft('');
  };

  const removeTag = (t: string) => {
    if (!contact) return;
    patch({ tags: contact.tags.filter((x) => x !== t) }, 'Tag removed');
  };

  const saveCustomFields = () => {
    const obj: Record<string, string> = {};
    for (const { key, value } of cfRows) {
      const k = key.trim();
      if (k) obj[k] = value;
    }
    patch({ customFields: obj }, 'Custom fields saved');
    setCfEditing(false);
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/contacts/${id}`, { method: 'DELETE' });
      toast.success('Contact deleted');
      router.push('/contacts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
      setDeleting(false);
    }
  };

  if (loading)
    return <div className="p-6 text-gray-400">Loading contact…</div>;

  if (notFound || !contact)
    return (
      <div className="p-6">
        <p className="text-gray-500 mb-4">Contact not found.</p>
        <Link href="/contacts" className="text-green-600 hover:underline">
          ← Back to contacts
        </Link>
      </div>
    );

  const initials = contact.name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const cfEntries = Object.entries(contact.custom_fields ?? {});

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <button
        onClick={() => router.push('/contacts')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-4"
      >
        <ArrowLeft size={16} /> Contacts
      </button>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-green-600 text-white flex items-center justify-center text-xl font-semibold shrink-0">
            {initials || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">
                {contact.name}
              </h1>
              <StatusPill status={contact.status} />
            </div>
            <p className="text-sm text-gray-600 mt-1">{contact.phone}</p>
            <p className="text-sm text-gray-600">{contact.email ?? '—'}</p>
            {(contact.address || contact.city) && (
              <p className="text-sm text-gray-600">
                {[contact.address, contact.city].filter(Boolean).join(', ')}
              </p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              Added {fmtDateTime(contact.created_at)} · Last activity{' '}
              {contact.last_message_at
                ? fmtDateTime(contact.last_message_at)
                : '—'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-5">
          <button
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Pencil size={14} /> Edit
          </button>
          {contact.status !== 'blocked' ? (
            <button
              onClick={() => patch({ status: 'blocked' }, 'Contact blocked')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Ban size={14} /> Block
            </button>
          ) : (
            <button
              onClick={() => patch({ status: 'active' }, 'Contact unblocked')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              <CheckCircle2 size={14} /> Unblock
            </button>
          )}
          {contact.status !== 'archived' ? (
            <button
              onClick={() => patch({ status: 'archived' }, 'Contact archived')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Archive size={14} /> Archive
            </button>
          ) : (
            <button
              onClick={() => patch({ status: 'active' }, 'Contact restored')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              <CheckCircle2 size={14} /> Restore
            </button>
          )}
          <button
            onClick={() => setDelOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

      {/* Tags */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Tags</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {contact.tags.length === 0 && (
            <span className="text-sm text-gray-400">No tags</span>
          )}
          {contact.tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs"
            >
              {t}
              <button onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2 max-w-sm">
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add tag and press Enter"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            onClick={addTag}
            className="px-3 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            <Plus size={16} />
          </button>
        </div>
      </section>

      {/* Custom fields */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Custom fields
          </h2>
          {!cfEditing ? (
            <button
              onClick={() => {
                setCfRows(
                  cfEntries.length
                    ? cfEntries.map(([key, value]) => ({
                        key,
                        value: String(value),
                      }))
                    : [{ key: '', value: '' }],
                );
                setCfEditing(true);
              }}
              className="text-sm text-green-600 hover:underline"
            >
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setCfEditing(false)}
                className="text-sm text-gray-500 hover:underline"
              >
                Cancel
              </button>
              <button
                onClick={saveCustomFields}
                className="text-sm text-green-600 hover:underline"
              >
                Save
              </button>
            </div>
          )}
        </div>

        {!cfEditing ? (
          cfEntries.length === 0 ? (
            <p className="text-sm text-gray-400">No custom fields</p>
          ) : (
            <dl className="divide-y divide-gray-100">
              {cfEntries.map(([k, v]) => (
                <div key={k} className="py-2 flex gap-4 text-sm">
                  <dt className="w-1/3 text-gray-500 truncate">{k}</dt>
                  <dd className="flex-1 text-gray-900 break-words">
                    {String(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )
        ) : (
          <div className="space-y-2">
            {cfRows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.key}
                  onChange={(e) =>
                    setCfRows((c) =>
                      c.map((r, j) =>
                        j === i ? { ...r, key: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="key"
                  className="w-1/3 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <input
                  value={row.value}
                  onChange={(e) =>
                    setCfRows((c) =>
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
                    setCfRows((c) =>
                      c.length === 1
                        ? [{ key: '', value: '' }]
                        : c.filter((_, j) => j !== i),
                    )
                  }
                  className="px-3 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setCfRows((c) => [...c, { key: '', value: '' }])
              }
              className="text-sm text-green-600 hover:underline inline-flex items-center gap-1"
            >
              <Plus size={14} /> Add field
            </button>
          </div>
        )}
      </section>

      {/* Timeline — no backend endpoint exists for per-contact message
          history (GET /contacts/:id returns the contact only). */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Timeline</h2>
        <p className="text-sm text-gray-400">
          Message history for a contact isn&apos;t available here yet. Open the{' '}
          <Link href="/inbox" className="text-green-600 hover:underline">
            Inbox
          </Link>{' '}
          to view conversations.
        </p>
      </section>

      <ContactFormModal
        open={editOpen}
        contact={contact}
        onClose={() => setEditOpen(false)}
        onSaved={load}
      />
      <ConfirmDialog
        open={delOpen}
        title="Delete contact"
        message={`Delete "${contact.name}"? This soft-deletes the contact.`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => !deleting && setDelOpen(false)}
      />
    </div>
  );
}
