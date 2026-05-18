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

export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BroadcastAudience {
  contactIds?: number[];
  segmentId?: number;
  filter?: SegmentFilter;
  variables?: Record<string, string>;
}

export interface Broadcast {
  id: number;
  company_id: number;
  template_id: number;
  name: string;
  audience_filter: BroadcastAudience;
  status: BroadcastStatus;
  scheduled_at: string | null;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  created_at: string;
}

export interface BroadcastAnalytics {
  id: number;
  name: string;
  status: BroadcastStatus;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  scheduledAt: string | null;
  createdAt: string;
}

/** Live socket payload on `broadcast.progress`. */
export interface BroadcastProgress {
  broadcastId: number;
  sent: number;
  failed: number;
  total: number;
  status?: BroadcastStatus;
}

export type BotTriggerType = 'exact' | 'contains' | 'regex';
export type BotActionType =
  | 'reply_template'
  | 'send_text'
  | 'assign_agent'
  | 'apply_tag'
  | 'fire_webhook';

export interface BotAction {
  type: BotActionType;
  templateId?: number;
  variables?: Record<string, string>;
  message?: string;
  userId?: number;
  tag?: string;
  webhookEndpointId?: number;
}

export interface Bot {
  id: number;
  company_id: number;
  name: string;
  trigger_type: BotTriggerType;
  keyword: string;
  actions: BotAction[];
  status: 'active' | 'inactive';
  created_at: string;
}

export interface Paged<T> {
  items: T[];
  meta: { page: number; limit: number; total: number };
}

// ---------------------------------------------------------------------------
// FE-3 — Analytics / Billing / Webhooks / Settings / super-admin Plans
// ---------------------------------------------------------------------------

export interface AnalyticsOverview {
  totalContacts: number;
  activeConversations: number;
  openChats: number;
  messagesThisMonth: number;
  deliveryRate: number;
  readRate: number;
  replyRate: number;
  botHandledPct: number;
}

export interface FunnelRow {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface AgentRow {
  userId: number;
  name: string;
  conversationsHandled: number;
  avgResponseTimeMin: number;
  messagesSent: number;
}

export interface ConversationCost {
  totalConversations: number;
  estimatedCostUSD: number;
  rateUsed: number;
  note: string;
}

export interface UsageInfo {
  period: string;
  usage: {
    messagesSent: number;
    contactsStored: number;
    templatesUsed: number;
    webhookCalls: number;
    conversationsOpened: number;
  };
  limits: {
    contactLimit: number;
    templateLimit: number;
    userLimit: number;
  } | null;
}

export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'cancelled';

export interface Invoice {
  id: number;
  company_id: number;
  amount: string | number;
  status: InvoiceStatus;
  due_date: string;
  paid_at: string | null;
  invoice_number: string | null;
  period: string | null;
  description: string | null;
  plan_snapshot: Record<string, unknown> | null;
  created_at: string;
}

export interface BillingSubscription {
  plan: string;
  monthlyPrice: number;
  limits: { contactLimit: number; templateLimit: number; userLimit: number };
  period: string;
  usage: {
    messagesSent: number;
    contactsStored: number;
    templatesUsed: number;
    webhookCalls: number;
    conversationsOpened: number;
  };
}

export type WebhookStatus = 'active' | 'inactive';

export interface WebhookEndpoint {
  id: number;
  company_id: number;
  endpoint_url: string;
  events: string[];
  status: WebhookStatus;
  secret: string; // always '(set)' from the API
  created_at: string;
}

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export interface WebhookLog {
  id: number;
  webhook_id: number;
  company_id: number;
  event_name: string;
  payload: Record<string, unknown>;
  delivery_status: WebhookDeliveryStatus;
  http_status: number | null;
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
}

export interface Plan {
  id: number;
  plan_name: string;
  contact_limit: number;
  template_limit: number;
  user_limit: number;
  monthly_price: string | number;
  setup_fee: string | number;
  webhook_enabled: boolean;
}

export type TeamRole = 'owner' | 'admin' | 'agent';
export type TeamMemberStatus = 'pending' | 'active' | 'suspended';

export interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: TeamRole;
  status: TeamMemberStatus;
  created_at: string;
}

export interface ShopifyIntegration {
  id: number;
  shop_domain: string;
  active_events: string[];
  status: 'active' | 'inactive' | 'error';
  created_at: string;
}

export interface ShopifySettings {
  integration: ShopifyIntegration | null;
  webhookKey: string;
  webhookSecretSet: boolean;
  adminTokenSet: boolean;
}

export interface ShopifyOrderConfig {
  enabled: boolean;
  templateId: number | null;
  languageCode: string | null;
  variableMap: Record<string, string>;
  confirmTag: string;
  cancelTag: string;
  pendingTag: string;
  decisionWindowMinutes: number;
  shopDomain: string;
  apiVersion: string;
}

export interface ShopifyOrderConfigResponse {
  config: ShopifyOrderConfig;
  fields: Array<{ key: string; label: string }>;
  apiVersions: string[];
  webhookKey: string;
  webhookSecretSet: boolean;
  adminTokenSet: boolean;
}

export interface OnboardingStatusView {
  step: number;
  completed: boolean;
  metaAppId: string | null;
  metaAccessToken: string | null;
  webhookVerifiedAt: string | null;
  testMessageSentAt: string | null;
  currentStep: number;
  webhookKey: string;
  webhookVerifyToken: string;
  webhookSecretSet: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
}
