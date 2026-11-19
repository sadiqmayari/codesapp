import { apiFetch, postMultipart } from '@/lib/api';

/** AI Agent v2 — typed API (Settings → AI Agent, inbox state/feedback/trace). */

export type Industry =
  | 'ecommerce'
  | 'clinic'
  | 'real_estate'
  | 'education'
  | 'restaurant'
  | 'services'
  | 'travel'
  | 'generic';

export interface LeadField {
  key: string;
  label: string;
  required: boolean;
}
export interface BookableService {
  name: string;
  durationMin: number;
  capacity: number;
  resource?: string;
}
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface DayHours {
  on: boolean;
  open: string;
  close: string;
}
export interface HoursConfig {
  enabled: boolean;
  days: Record<DayKey, DayHours>;
  holidays: string[];
  offHoursMode: 'full' | 'no_transactions' | 'away_only';
  awayMessage: string;
}
export interface HandoffConfig {
  asksHuman: boolean;
  upset: boolean;
  noProgressTurns: number;
  orderValueAbove: number | null;
  paymentSlip: boolean;
  keywords: string[];
  messageInHours: string;
  messageOffHours: string;
  assignTo: 'round_robin' | 'pool';
  resumeAfterMin: number;
  humanReplyPauseMin: number;
}
export interface SkillsConfig {
  knowledge: { enabled: boolean };
  orders: { enabled: boolean; allowCod: boolean; allowPrepaid: boolean };
  order_status: { enabled: boolean };
  payments: { enabled: boolean };
  bookings: { enabled: boolean; services: BookableService[]; leadTimeMin: number; maxDaysAhead: number };
  leads: { enabled: boolean; fields: LeadField[]; hotRule: string; tag: string };
  handoff: { enabled: boolean };
}

export interface AgentProfile {
  industry: Industry;
  agentName: string;
  agentRole: string;
  goals: string;
  doRules: string;
  dontRules: string;
  tone: string;
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  languages: string[];
  mirrorLanguage: boolean;
  voiceLanguage: string;
  paymentMethods: string[];
  skills: SkillsConfig;
  handoff: HandoffConfig;
  hours: HoursConfig;
  engine: 'v1' | 'shadow' | 'v2';
  domainRules: string;
  sensitiveTopics: string[];
  paymentDetails: string;
  saved: boolean;
  packs: Array<{ key: Industry; label: string; description: string }>;
}

export interface IndustryPack {
  key: Industry;
  label: string;
  description: string;
  agentName: string;
  agentRole: string;
  goals: string;
  doRules: string;
  dontRules: string;
  skills: string[];
  leadFields: LeadField[];
  hotLeadRule: string;
  services: BookableService[];
}

export interface AgentStatus {
  blocked: 'platform_off' | 'plan' | 'admin_disabled' | 'tenant_disabled' | 'cap_reached' | null;
  engine: 'v1' | 'shadow' | 'v2';
  autoReplyAll: boolean;
  autoOrder: boolean;
  usage: { billedCents: number; capCents: number; requests: number };
}

export interface StoreAiProfile {
  storeId: number;
  label: string;
  provider: string;
  isPrimary: boolean;
  brandName: string;
  tone: string;
  currencyCode: string;
  currencySymbol: string;
  countryCode: string;
  paymentDetailsSet: boolean;
}

export const getAgentProfile = () => apiFetch<AgentProfile>('/ai/agent/profile');
export const saveAgentProfile = (body: Partial<Record<string, unknown>>) =>
  apiFetch<AgentProfile>('/ai/agent/profile', { method: 'PATCH', body });
export const getPack = (key: Industry) => apiFetch<IndustryPack>(`/ai/agent/packs/${key}`);
export const getAgentStatus = () => apiFetch<AgentStatus>('/ai/agent/status');
export const getStoreProfiles = () => apiFetch<StoreAiProfile[]>('/ai/agent/stores');
export const saveStoreProfile = (storeId: number, body: Record<string, unknown>) =>
  apiFetch<{ ok: boolean }>(`/ai/agent/stores/${storeId}`, { method: 'PATCH', body });

// ── Playground ──
export interface PlaygroundMsg {
  role: 'customer' | 'ai';
  text: string;
}
export interface AgentTrace {
  model?: string;
  provider?: string;
  tier?: string;
  promptVersion?: string;
  latencyMs?: number;
  costMicros?: number;
  tools?: Array<{ name: string; ok: boolean; ms: number; summary: string }>;
  sources?: Array<{ title: string; sourceType: string; score: number }>;
  storeId?: number | null;
  open?: boolean;
  systemReply?: boolean;
  handoff?: { reason: string; category: string } | null;
  reply?: string;
  messageId?: number | null;
  memoryStage?: string;
  orderPlaced?: string | null;
  bookingMade?: number | null;
}
export interface PlaygroundResult {
  reply: string | null;
  memory: Record<string, unknown>;
  trace: AgentTrace;
  handoff: { reason: string; category: string } | null;
}
export const runPlayground = (messages: PlaygroundMsg[], memory: unknown, storeId?: number | null) =>
  apiFetch<PlaygroundResult>('/ai/agent/playground', {
    method: 'POST',
    body: { messages, memory: memory ?? undefined, storeId: storeId ?? undefined },
  });

// ── Inbox ──
export type ChatAiState =
  | 'off'
  | 'muted'
  | 'blocked'
  | 'handed_off'
  | 'human_active'
  | 'off_hours'
  | 'on_chat'
  | 'on_workspace';
export interface ChatAiStateResult {
  state: ChatAiState;
  until: string | null;
  blockReason: AgentStatus['blocked'];
  open: boolean;
  offHoursMode: HoursConfig['offHoursMode'];
  engine: AgentProfile['engine'];
  stage: string;
  handoffAt: string | null;
}
export const getChatAiState = (conversationId: number) =>
  apiFetch<ChatAiStateResult>(`/ai/agent/state/${conversationId}`, { noOnboardingRedirect: true });
export const resumeAi = (conversationId: number) =>
  apiFetch<{ ok: boolean }>(`/ai/agent/resume/${conversationId}`, { method: 'POST' });
export interface TraceEvent {
  id: number;
  type: string;
  at: string;
  payload: (AgentTrace & Record<string, unknown>) | null;
}
export const getTrace = (conversationId: number) =>
  apiFetch<{ events: TraceEvent[]; feedback: Array<{ message_id: number; user_id: number; rating: number; reason: string | null }> }>(
    `/ai/agent/trace/${conversationId}`,
  );
export const sendAiFeedback = (messageId: number, rating: 1 | -1, reason?: string) =>
  apiFetch<{ ok: boolean }>('/ai/agent/feedback', { method: 'POST', body: { messageId, rating, reason } });

// ── Performance / bookings ──
export interface AgentPerformance {
  days: number;
  aiChats: number;
  aiReplies: number;
  resolvedByAiPct: number | null;
  handoffs: number;
  handoffsByReason: Array<{ reason: string; count: number }>;
  ordersCreated: number;
  leadsQualified: number;
  bookingsMade: number;
  feedback: { up: number; down: number; downPct: number | null };
  billedUsd: number;
  costPerChatUsd: number | null;
  unanswered: Array<{ question: string; count: number }>;
  shadowTurns: number;
}
export const getPerformance = (days = 30) => apiFetch<AgentPerformance>(`/ai/agent/performance?days=${days}`);
export interface AiBooking {
  id: number;
  service: string;
  resource: string | null;
  starts_at: string;
  ends_at: string;
  party_size: number;
  name: string | null;
  phone: string | null;
  status: string;
  created_by: string;
  conversation_id: number | null;
}
export const listBookings = () => apiFetch<AiBooking[]>('/ai/agent/bookings');
export const cancelBooking = (id: number) =>
  apiFetch<{ ok: boolean }>(`/ai/agent/bookings/${id}/cancel`, { method: 'POST' });

// ── Knowledge v2 ──
export interface KnowledgeIndexStatus {
  configured: boolean;
  products: number;
  policies: number;
  manual: number;
  total: number;
  lastSyncedAt: string | null;
  byStore: Array<{ storeId: number; products: number; policies: number; lastSyncedAt: string | null }>;
}
export const getKnowledgeIndex = () => apiFetch<KnowledgeIndexStatus>('/ai/knowledge/index-status');
export const importKnowledgeUrl = (url: string) =>
  apiFetch<{ imported: number; failed: number; titles: string[] }>('/ai/knowledge/import-url', {
    method: 'POST',
    body: { url },
  });
export const importKnowledgeFile = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return postMultipart<{ title: string; chars: number }>('/ai/knowledge/import-file', fd);
};
export const testKnowledge = (question: string, storeId?: number | null) =>
  apiFetch<{ hits: Array<{ title: string; sourceType: string; storeId: number; score: number; preview: string }> }>(
    '/ai/knowledge/test',
    { method: 'POST', body: { question, storeId: storeId ?? undefined } },
  );
export const reindexKnowledge = () => apiFetch<{ entries: number }>('/ai/knowledge/reindex', { method: 'POST' });
export const syncStoreKnowledge = (opts: { storeId?: number; all?: boolean }) =>
  apiFetch<{ started: boolean }>(
    `/shopify/sync-knowledge${opts.all ? '?all=1' : opts.storeId ? `?storeId=${opts.storeId}` : ''}`,
    { method: 'POST' },
  );

export const INDUSTRY_LABEL: Record<Industry, string> = {
  ecommerce: 'Online store',
  clinic: 'Clinic / healthcare',
  real_estate: 'Real estate',
  education: 'Education',
  restaurant: 'Restaurant',
  services: 'Services / salon',
  travel: 'Travel',
  generic: 'General business',
};
