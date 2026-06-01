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
export interface AiSettings {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  brandTone: string | null;
  defaultLanguage: string | null;
  monthlyCapCents: number | null;
  planAiEnabled: boolean;
}

export function aiGetSettings(): Promise<AiSettings> {
  return apiFetch('/ai/settings');
}

export function aiUpdateSettings(body: {
  aiEnabled?: boolean;
  autoReplyEnabled?: boolean;
  brandTone?: string | null;
  defaultLanguage?: string | null;
  monthlyCapCents?: number | null;
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
