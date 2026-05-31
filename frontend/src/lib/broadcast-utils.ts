// Helpers for the broadcast campaign builder: template placeholder parsing
// + per-recipient personalization token handling (mirrors the backend
// BroadcastsService.resolveVariableValue contract).

import type { Template } from '@/lib/crm-types';

/** Sample contact used to render the personalization live preview. */
export interface SampleContact {
  name: string;
  phone: string;
  email: string;
  custom_fields: Record<string, string>;
}

export const SAMPLE_CONTACT: SampleContact = {
  name: 'Ayesha Khan',
  phone: '+92 300 1234567',
  email: 'ayesha@example.com',
  custom_fields: { order_id: '#1042', city: 'Lahore' },
};

export type FieldKind = 'text' | 'name' | 'phone' | 'email' | 'custom';

/** Pull the BODY (and HEADER text) component strings out of a template. */
function componentText(template: Template, type: 'BODY' | 'HEADER'): string {
  const c = template.content?.components?.find((x) => x.type === type);
  return c?.text ?? '';
}

export function getBodyText(template: Template): string {
  return componentText(template, 'BODY');
}

export function getHeaderText(template: Template): string {
  const c = template.content?.components?.find((x) => x.type === 'HEADER');
  return c?.format === 'TEXT' || !c?.format ? c?.text ?? '' : '';
}

export function getFooterText(template: Template): string {
  const c = template.content?.components?.find((x) => x.type === 'FOOTER');
  return c?.text ?? '';
}

export function getButtons(template: Template) {
  const c = template.content?.components?.find((x) => x.type === 'BUTTONS');
  return c?.buttons ?? [];
}

/** Unique, ascending placeholder numbers ({{1}}, {{2}}…) used in the template. */
export function extractPlaceholders(template: Template): number[] {
  const text = `${getHeaderText(template)} ${getBodyText(template)}`;
  const nums = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) nums.add(Number(m[1]));
  return Array.from(nums).sort((a, b) => a - b);
}

/** Build the stored variable value for a chosen field kind. */
export function tokenFor(kind: FieldKind, customKey = ''): string {
  switch (kind) {
    case 'name':
      return '{{contact.name}}';
    case 'phone':
      return '{{contact.phone}}';
    case 'email':
      return '{{contact.email}}';
    case 'custom':
      return `{{contact.custom.${customKey}}}`;
    default:
      return '';
  }
}

/** Inverse of tokenFor — read the kind/customKey back from a stored value. */
export function parseToken(value: string): {
  kind: FieldKind;
  customKey: string;
} {
  const m = /^\{\{\s*contact\.([a-zA-Z0-9_.]+)\s*\}\}$/.exec(value ?? '');
  if (!m) return { kind: 'text', customKey: '' };
  const path = m[1];
  if (path === 'name') return { kind: 'name', customKey: '' };
  if (path === 'phone') return { kind: 'phone', customKey: '' };
  if (path === 'email') return { kind: 'email', customKey: '' };
  if (path.startsWith('custom.'))
    return { kind: 'custom', customKey: path.slice('custom.'.length) };
  return { kind: 'text', customKey: '' };
}

/** Resolve a stored value against the sample contact (client preview only). */
export function resolveForSample(value: string, c: SampleContact): string {
  const { kind, customKey } = parseToken(value);
  switch (kind) {
    case 'name':
      return c.name;
    case 'phone':
      return c.phone;
    case 'email':
      return c.email;
    case 'custom':
      return c.custom_fields[customKey] ?? `{{${customKey}}}`;
    default:
      return value ?? '';
  }
}

/** Substitute {{n}} placeholders in `text` with resolved sample values. */
export function renderWithValues(
  text: string,
  variables: Record<string, string>,
  c: SampleContact,
): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => {
    const raw = variables[n];
    if (raw == null || raw === '') return `{{${n}}}`;
    return resolveForSample(raw, c);
  });
}
