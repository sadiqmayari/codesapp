'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import type { Contact } from '@/lib/crm-types';
import { looksLikePhone } from '@/lib/contacts';
import { TagEditor } from './tag-editor';
import {
  CustomFieldsEditor,
  FieldRow,
  fieldsFromRows,
  rowsFromFields,
} from './custom-fields-editor';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  // Local formats are fine — the server canonicalizes 0300… → 92300…
  phone: z
    .string()
    .trim()
    .min(1, 'Phone is required')
    .refine(looksLikePhone, 'Enter a full mobile number, e.g. 0300 1234567 or +92 300 1234567'),
  email: z.string().trim().email('Enter a valid email').max(191).optional().or(z.literal('')),
  city: z.string().trim().max(128).optional(),
  address: z.string().trim().max(500).optional(),
});
type FormValues = z.infer<typeof schema>;

const inputCls =
  'w-full h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none disabled:bg-sunken disabled:text-muted';

/**
 * Create / edit a contact (Contacts 360). Phone is editable on edit for
 * owners/admins only (`canEditPhone`); the server re-validates and 409s on a
 * clash. The modal only closes after the save succeeds.
 */
export function ContactFormModal({
  open,
  onClose,
  onSaved,
  contact,
  canEditPhone = false,
  tagSuggestions = [],
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (contact?: Contact) => void;
  contact?: Contact | null;
  canEditPhone?: boolean;
  tagSuggestions?: string[];
}) {
  const toast = useToast();
  const editing = !!contact;
  const [tags, setTags] = useState<string[]>([]);
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
      city: contact?.city ?? '',
      address: contact?.address ?? '',
    });
    setTags(Array.isArray(contact?.tags) ? [...contact!.tags] : []);
    setRows(rowsFromFields(contact?.custom_fields));
    setFormError(null);
  }, [open, contact, reset]);

  const onSubmit = async (v: FormValues) => {
    const cf = fieldsFromRows(rows);
    if ('error' in cf) {
      setFormError(cf.error);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: v.name,
        email: v.email || null,
        city: v.city || null,
        address: v.address || null,
        tags,
        customFields: cf.fields,
      };
      let saved: Contact;
      if (editing) {
        if (canEditPhone && v.phone !== contact!.phone) body.phone = v.phone;
        saved = await apiFetch<Contact>(`/contacts/${contact!.id}`, { method: 'PATCH', body });
        toast.success('Contact updated');
      } else {
        saved = await apiFetch<Contact>('/contacts', {
          method: 'POST',
          body: { ...body, phone: v.phone, email: v.email || undefined },
        });
        toast.success('Contact created');
      }
      onSaved(saved);
    } catch (e) {
      const msg = e instanceof ApiError ? e.userMessage : 'Could not save the contact';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const field = (id: string, label: string, el: React.ReactNode, error?: string, hint?: string) => (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-ink mb-1">
        {label}
      </label>
      {el}
      {error ? (
        <p className="text-xs text-red-600 mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted mt-1">{hint}</p>
      ) : null}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title={editing ? 'Edit contact' : 'New contact'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="contact-form" loading={submitting}>
            {editing ? 'Save changes' : 'Create contact'}
          </Button>
        </div>
      }
    >
      <form id="contact-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {formError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {field(
            'cf-name',
            'Name',
            <input id="cf-name" {...register('name')} className={inputCls} autoComplete="off" />,
            errors.name?.message,
          )}
          {field(
            'cf-phone',
            'WhatsApp number',
            <input
              id="cf-phone"
              {...register('phone')}
              readOnly={editing && !canEditPhone}
              className={inputCls}
              inputMode="tel"
              placeholder="0300 1234567"
            />,
            errors.phone?.message,
            editing && !canEditPhone
              ? 'Only owners and admins can change a number'
              : 'Local or international format',
          )}
          {field(
            'cf-email',
            'Email',
            <input id="cf-email" type="email" {...register('email')} className={inputCls} placeholder="Optional" />,
            errors.email?.message,
          )}
          {field(
            'cf-city',
            'City',
            <input id="cf-city" {...register('city')} className={inputCls} placeholder="Optional" />,
            errors.city?.message,
          )}
        </div>
        {field(
          'cf-address',
          'Address',
          <input id="cf-address" {...register('address')} className={inputCls} placeholder="Optional" />,
          errors.address?.message,
        )}
        <div>
          <span className="block text-xs font-semibold text-ink mb-1">Tags</span>
          <TagEditor tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>
        <div>
          <span className="block text-xs font-semibold text-ink mb-1">Custom fields</span>
          <CustomFieldsEditor rows={rows} onChange={setRows} />
        </div>
      </form>
    </Modal>
  );
}
