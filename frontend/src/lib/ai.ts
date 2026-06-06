import { apiFetch } from '@/lib/api';

export type RewriteMode = 'polite' | 'shorten' | 'expand' | 'fix';

export interface AiKnowledgeEntry {
  id: number;
  company_id: number;
  title: string;
  content: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiUsage {
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  billedCents: number;
  capCents: number;
  multiplier: number;
}

/**
 * Per-conversation AI auto-pilot. 'on' = AI auto-replies on this chat (even if
 * assigned), 'off' = muted, 'default' = follow the workspace setting.
 */
export function aiSetConversationAutoReply(
  conversationId: number,
  mode: 'on' | 'off' | 'default',
): Promise<unknown> {
  return apiFetch(`/inbox/conversations/${conversationId}/ai-autoreply`, {
    method: 'POST',
    body: { mode },
  });
}

export function aiSuggestReply(
  conversationId: number,
  instruction?: string,
): Promise<{ text: string }> {
  return apiFetch('/ai/suggest-reply', {
    method: 'POST',
    body: { conversationId, instruction },
  });
}

export function aiSummarize(conversationId: number): Promise<{ text: string }> {
  return apiFetch('/ai/summarize', {
    method: 'POST',
    body: { conversationId },
  });
}

export interface AiDraftOrder {
  items: Array<{ productQuery: string; quantity: number }>;
  customer: {
    name: string | null;
    phone: string | null;
    address1: string | null;
    city: string | null;
    countryCode: string | null;
  };
  paymentMethod: 'cod' | 'prepaid' | null;
  note: string | null;
  confidence: 'high' | 'low';
  missing: string[];
  readyToCreate?: boolean;
}

/**
 * Ask the AI to draft a Shopify order from the conversation. The result is a
 * suggestion the agent reviews/edits before creating — product names come back
 * as free-text queries the modal resolves to real variants.
 */
export function aiDraftOrder(conversationId: number): Promise<AiDraftOrder> {
  return apiFetch('/ai/draft-order', {
    method: 'POST',
    body: { conversationId },
  });
}

export function aiRewrite(
  text: string,
  mode: RewriteMode,
): Promise<{ text: string }> {
  return apiFetch('/ai/rewrite', { method: 'POST', body: { text, mode } });
}

export function aiTranslate(
  text: string,
  targetLang: string,
): Promise<{ text: string }> {
  return apiFetch('/ai/translate', {
    method: 'POST',
    body: { text, targetLang },
  });
}

export function aiGetUsage(): Promise<AiUsage> {
  return apiFetch('/ai/usage');
}

// ── Settings ───────────────────────────────────────────────────────────
export interface AiCostEstimates {
  provider: 'anthropic' | 'openai';
  standardPer1kRepliesUsd: number;
  highAccuracyPer1kRepliesUsd: number;
  visionPer100PhotosUsd: number;
  voicePerMinuteUsd: number;
}

export interface AiSettings {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  autoOrderEnabled: boolean;
  autoOrderAllEnabled: boolean;
  brandTone: string | null;
  defaultLanguage: string | null;
  monthlyCapCents: number | null;
  /** Tenant-selectable autonomous AI quality. null = follow platform default. */
  aiTier: 'fast' | 'smart' | null;
  visionEnabled: boolean;
  voiceEnabled: boolean;
  /** Super-admin kill-switch (read-only) — when true, premium controls disabled. */
  premiumLocked: boolean;
  planAiEnabled: boolean;
  estimates: AiCostEstimates;
}

export function aiGetSettings(): Promise<AiSettings> {
  return apiFetch('/ai/settings');
}

export function aiUpdateSettings(body: {
  aiEnabled?: boolean;
  autoReplyEnabled?: boolean;
  autoOrderEnabled?: boolean;
  autoOrderAllEnabled?: boolean;
  brandTone?: string | null;
  defaultLanguage?: string | null;
  monthlyCapCents?: number | null;
  aiTier?: 'fast' | 'smart' | null;
  visionEnabled?: boolean;
  voiceEnabled?: boolean;
}): Promise<AiSettings> {
  return apiFetch('/ai/settings', { method: 'PATCH', body });
}

// ── Knowledge base ─────────────────────────────────────────────────────
export function aiListKnowledge(): Promise<AiKnowledgeEntry[]> {
  return apiFetch('/ai/knowledge');
}

export function aiCreateKnowledge(body: {
  title: string;
  content: string;
  enabled?: boolean;
}): Promise<AiKnowledgeEntry> {
  return apiFetch('/ai/knowledge', { method: 'POST', body });
}

export function aiUpdateKnowledge(
  id: number,
  body: { title?: string; content?: string; enabled?: boolean },
): Promise<AiKnowledgeEntry> {
  return apiFetch(`/ai/knowledge/${id}`, { method: 'PATCH', body });
}

export function aiDeleteKnowledge(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/ai/knowledge/${id}`, { method: 'DELETE' });
}
