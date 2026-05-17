'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { X, Plus } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import type { Contact } from '@/lib/crm-types';

// Mirrors backend PHONE_REGEX: /^\+?[1-9]\d{6,14}$/
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  phone: z
    .string()
    .min(1, 'Phone is required')
    .regex(PHONE_RE, 'Use E.164 format, e.g. +14155552671'),
  email: z
    .string()
    .email('Invalid email')
    .optional()
    .or(z.literal('')),
});
type FormValues = z.infer<typeof schema>;

interface CustomField {
  key: string;
  value: string;
}

export function ContactFormModal({
  open,
  onClose,
  onSaved,
  contact,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  contact?: Contact | null;
}) {
  const toast = useToast();
  const editing = !!contact;
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [cf, setCf] = useState<CustomField[]>([{ key: '', value: '' }]);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    reset({
      name: contact?.name ?? '',
      phone: contact?.phone ?? '',
      email: contact?.email ?? '',
    });
    setTags(Array.isArray(contact?.tags) ? [...(contact!.tags as string[])] : []);
    setTagDraft('');
    const entries = Object.entries(contact?.custom_fields ?? {});
    setCf(
      entries.length
        ? entries.map(([key, value]) => ({ key, value: String(value) }))
        : [{ key: '', value: '' }],
    );
  }, [open, contact, reset]);

  const addTag = () => {
    const t = tagDraft.trim();
    if (t && !tags.includes(t)) setTags((cur) => [...cur, t]);
    setTagDraft('');
  };

  const onSubmit = async (data: FormValues) => {
    setSubmitting(true);
    const customFields: Record<string, string> = {};
    for (const { key, value } of cf) {
      const k = key.trim();
      if (k) customFields[k] = value;
    }
    const body = {
      name: data.name,
      phone: data.phone,
      email: data.email ? data.email : undefined,
      tags,
      customFields,
    };
    try {
      if (editing) {
        await apiFetch(`/contacts/${contact!.id}`, {
          method: 'PATCH',
          body: {
            name: body.name,
            email: body.email ?? null,
            tags: body.tags,
            customFields: body.customFields,
          },
        });
        toast.success('Contact updated');
      } else {
        await apiFetch('/contacts', { method: 'POST', body });
        toast.success('Contact created');
      }
      onSaved();
      onClose();
    } catch (e) {
      // 403 = duplicate phone OR plan contact_limit reached — backend message.
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to save contact',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit contact' : 'New contact'}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="contact-form"
            disabled={submitting}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
          >
            {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create'}
          </button>
        </>
      }
    >
      <form
        id="contact-form"
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name *
          </label>
          <input
            {...register('name')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {errors.name && (
            <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Phone *{' '}
            {editing && (
              <span className="text-xs text-gray-400">
                (cannot be changed)
              </span>
            )}
          </label>
          <input
            {...register('phone')}
            disabled={editing}
            placeholder="+14155552671"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100 disabled:text-gray-500"
          />
          {errors.phone && (
            <p className="text-red-500 text-xs mt-1">{errors.phone.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email
          </label>
          <input
            {...register('email')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {errors.email && (
            <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Tags
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs"
              >
                {t}
                <button
                  type="button"
                  onClick={() => setTags((c) => c.filter((x) => x !== t))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
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
              type="button"
              onClick={addTag}
              className="px-3 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Custom fields
          </label>
          <div className="space-y-2">
            {cf.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.key}
                  onChange={(e) =>
                    setCf((c) =>
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
                    setCf((c) =>
                      c.map((r, j) =>
                        j === i ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="value"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <button
                  type="button"
                  onClick={() =>
                    setCf((c) =>
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
          </div>
          <button
            type="button"
            onClick={() => setCf((c) => [...c, { key: '', value: '' }])}
            className="mt-2 text-sm text-green-600 hover:underline inline-flex items-center gap-1"
          >
            <Plus size={14} /> Add field
          </button>
        </div>
      </form>
    </Modal>
  );
}
