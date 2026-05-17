// Shared types for FE-2a (contacts, templates, segments, super-admin clients).
// Mirrors the backend Prisma shapes consumed by the frontend.

export type ContactStatus = 'active' | 'blocked' | 'archived';

export interface Contact {
  id: number;
  company_id: number;
  name: string;
  phone: string;
  email: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  last_message_at: string | null;
  status: ContactStatus;
  created_at: string;
}

export interface SegmentFilter {
  tags?: string[];
  status?: ContactStatus;
  lastMessageAfter?: string;
  lastMessageBefore?: string;
  hasEmail?: boolean;
}

export interface Segment {
  id: number;
  company_id: number;
  name: string;
  filter: SegmentFilter;
  created_at: string;
  updated_at: string;
}

export type TemplateStatus = 'pending' | 'approved' | 'rejected' | 'paused';
export type TemplateCategory = 'marketing' | 'utility' | 'authentication';

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'DOCUMENT';
  text?: string;
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phone_number?: string;
  }>;
}

export interface TemplateContent {
  language: string;
  components: TemplateComponent[];
}

export interface Template {
  id: number;
  company_id: number;
  meta_template_id: string | null;
  name: string;
  category: TemplateCategory;
  status: TemplateStatus;
  content: TemplateContent;
  rejection_reason: string | null;
  created_at: string;
}

export type ActivationStatus = 'pending' | 'active' | 'suspended';

export interface Subscription {
  id: number;
  plan_name: string;
  contact_limit: number;
  template_limit: number;
  user_limit: number;
  monthly_price: string | number;
}

export interface ClientCompany {
  id: number;
  company_name: string;
  activation_status: ActivationStatus;
  created_at: string;
  subscription: Subscription | null;
  users?: Array<{
    id: number;
    name: string;
    email: string;
    role: string;
    status: string;
  }>;
}

export interface Paged<T> {
  items: T[];
  meta: { page: number; limit: number; total: number };
}
