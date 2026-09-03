// Shared types for FE-2a (contacts, templates, segments, super-admin clients).
// Mirrors the backend Prisma shapes consumed by the frontend.

export type ContactStatus = 'active' | 'blocked' | 'archived';

export interface Contact {
  id: number;
  company_id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  city: string | null;
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
  // Meta requires example values for any variable used (body/header/dynamic
  // URL), or it rejects the template. Shapes per Meta's API:
  //   BODY:   { body_text: [[sample1, sample2, …]] }
  //   HEADER: { header_text: [sample] }
  example?: {
    body_text?: string[][];
    header_text?: string[];
  };
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phone_number?: string;
    // Dynamic URL button: a full example URL with the variable filled in.
    example?: string[];
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

export type UsageLimitAction = 'block' | 'warn_only';

export interface ClientCompany {
  id: number;
  company_name: string;
  activation_status: ActivationStatus;
  created_at: string;
  activated_at?: string | null;
  suspended_at?: string | null;
  grace_until?: string | null;
  usage_limit_action?: UsageLimitAction | null;
  subscription: Subscription | null;
  users?: Array<{
    id: number;
    name: string;
    email: string;
    role: string;
    status: string;
  }>;
}

/** GET /billing/account-status — JWT-only, works while suspended. */
export interface AccountStatus {
  activationStatus: ActivationStatus;
  suspendedForBilling: boolean;
  suspendedAt: string | null;
  graceUntil: string | null;
  unpaidInvoices: Invoice[];
}

export interface PlatformSettings {
  usageLimitAction: UsageLimitAction;
  aiProvider?: 'anthropic' | 'openai';
  aiAutonomousTier?: 'fast' | 'smart';
  aiAgentCompanyIds?: string;
}

export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BroadcastAudience {
  all?: boolean;
  contactIds?: number[];
  segmentId?: number;
  filter?: SegmentFilter;
  variables?: Record<string, string>;
}

/** POST /broadcasts/preview-audience response. */
export interface AudiencePreview {
  count: number;
  sample: Array<{ id: number; name: string; phone: string }>;
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
  | 'send_media'
  | 'assign_agent'
  | 'apply_tag'
  | 'fire_webhook'
  | 'ai_reply';

export interface BotAction {
  type: BotActionType;
  templateId?: number;
  variables?: Record<string, string>;
  message?: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaFilename?: string;
  caption?: string;
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

// Saved canned / quick replies (company-wide composer snippets).
export interface CannedReply {
  id: number;
  company_id: number;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
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

// Super-admin invoices list — Invoice + the joined company name.
export interface AdminInvoice extends Invoice {
  company?: { company_name: string } | null;
}

// Super-admin platform usage (current period only).
export interface AdminUsageRow {
  id: number;
  company_id: number;
  period: string;
  messages_sent: number;
  contacts_stored: number;
  templates_used: number;
  webhook_calls: number;
  conversations_opened: number;
  /** AI calls this month. */
  ai_requests: number;
  /** Raw provider cost this month, in micro-dollars (pre-markup). */
  ai_cost_micros: number;
  /** What the tenant is billed for that AI usage this month, in cents. */
  ai_billed_cents: number;
  company?: {
    company_name: string;
    subscription: Subscription | null;
  } | null;
}

// Super-admin audit-log row (user joined).
export interface AdminAuditLog {
  id: number;
  company_id: number | null;
  user_id: number;
  action: string;
  entity: string;
  entity_id: number | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  user?: { name: string; email: string } | null;
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
  // Present only when AI is enabled for the tenant. Accruing AI charges for the
  // current billing cycle — added to the next invoice (post-paid).
  aiUsage?: {
    billedCents: number;
    cycleStart: string;
    nextInvoiceDate: string;
  } | null;
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
  ai_enabled?: boolean;
  proactive_notifications?: boolean;
  // Public pricing-card fields (super-admin controlled)
  is_public: boolean;
  display_order: number;
  is_highlighted: boolean;
  tagline: string | null;
  features: string[] | null;
  cta_label: string | null;
  currency: string;
  billing_period: string;
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
  // Delivery notifications — per-event config keyed by event_key.
  deliveryNotifications: Record<string, DeliveryNotificationCfg>;
  // Abandoned-cart recovery wait (minutes) before the recovery template sends.
  abandonedCartDelayMinutes: number;
  // Multi-step recovery sequence. Empty = single legacy template + delay above.
  abandonedCartSteps?: AbandonedCartStep[];
  // Template for the MANUAL per-row "Send message" button on the abandoned
  // -checkouts table. Independent of the automated sequence above.
  abandonedManualTemplate?: {
    templateId: number | null;
    variableMap: Record<string, string>;
  } | null;
}

export interface AbandonedCartStep {
  delayMinutes: number;
  templateId: number;
  variableMap: Record<string, string>;
}

export interface DeliveryNotificationCfg {
  templateId: number | null;
  variableMap: Record<string, string>;
  enabled: boolean;
}

export interface ShopifyOrderConfigResponse {
  config: ShopifyOrderConfig;
  fields: Array<{ key: string; label: string }>;
  apiVersions: string[];
  webhookKey: string;
  webhookSecretSet: boolean;
  adminTokenSet: boolean;
  // Delivery-notification gating: `proactivePlan` = plan includes it
  // (super-admin authority); `proactiveEnabled` = tenant master toggle.
  proactivePlan: boolean;
  proactiveEnabled: boolean;
  deliveryEvents: Array<{ key: string; label: string; source: string }>;
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
