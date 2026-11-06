import { apiFetch, postMultipart } from './api';

export interface RosterUser {
  id: number;
  name: string;
  role: string;
  online: boolean;
  lastSeen: string | null;
}

export interface ThreadItem {
  id: number;
  kind: 'dm' | 'broadcast';
  title: string;
  otherUserId: number | null;
  online?: boolean;
  lastSeen: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export type ChatMessageType = 'text' | 'image' | 'audio' | 'file' | 'order' | 'chat';

export interface ChatMessage {
  id: number;
  threadId: number;
  senderId: number;
  type: ChatMessageType;
  content: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaName: string | null;
  clientId: string | null;
  createdAt: string;
}

export interface BroadcastMember {
  userId: number;
  name: string;
  lastReadAt: string | null;
}

export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor: number | null;
  /** DM-only read/delivered watermarks of the OTHER member, for sender ticks. */
  otherReadAt: string | null;
  otherDeliveredAt: string | null;
  /** Broadcast-only: every OTHER member's read watermark, for "seen by N". */
  broadcastMembers?: BroadcastMember[];
}

/** Compact order snapshot shared into a chat (stored as JSON in message.content). */
export interface OrderShare {
  number: string;
  gid?: string | null;
  customerName?: string | null;
  status?: string | null;
  total?: string | number | null;
  currency?: string | null;
  itemCount?: number | null;
}

export function parseOrderCard(content: string | null): OrderShare | null {
  if (!content) return null;
  try {
    const o = JSON.parse(content) as OrderShare;
    return o && o.number ? o : null;
  } catch {
    return null;
  }
}

/** Compact WhatsApp-conversation snapshot shared into team chat (JSON in content). */
export interface ChatShare {
  conversationId: number;
  contactName?: string | null;
  phone?: string | null;
  preview?: string | null;
}

export function parseChatCard(content: string | null): ChatShare | null {
  if (!content) return null;
  try {
    const c = JSON.parse(content) as ChatShare;
    return c && c.conversationId ? c : null;
  } catch {
    return null;
  }
}

/** A customer conversation result for the chat-share picker. */
export interface ChatPickItem {
  id: number;
  name: string;
  phone: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

/** Search WhatsApp conversations (by contact name / phone) to share one. */
export async function searchInboxConversations(q: string): Promise<ChatPickItem[]> {
  const params = new URLSearchParams({ status: 'all', limit: '20' });
  if (q.trim()) params.set('search', q.trim());
  const rows = await apiFetch<
    {
      id: number;
      contact: { name: string; phone: string };
      last_message: string | null;
      last_message_at: string | null;
    }[]
  >(`/inbox/conversations?${params.toString()}`);
  return rows.map((r) => ({
    id: r.id,
    name: r.contact?.name ?? 'Unknown',
    phone: r.contact?.phone ?? '',
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
  }));
}

export const getRoster = () => apiFetch<RosterUser[]>('/team-chat/roster');
export const getThreads = () => apiFetch<ThreadItem[]>('/team-chat/threads');
export const getTeamUnread = () => apiFetch<{ unread: number }>('/team-chat/unread');
export const getPresence = () => apiFetch<{ online: number[] }>('/team-chat/presence');

export const openDm = (userId: number) =>
  apiFetch<ThreadItem>('/team-chat/threads/dm', { method: 'POST', body: { userId } });

export const getThreadMessages = (threadId: number, cursor?: number) =>
  apiFetch<MessagesPage>(
    `/team-chat/threads/${threadId}/messages${cursor ? `?cursor=${cursor}` : ''}`,
  );

export const sendTeamText = (threadId: number, text: string, clientId: string) =>
  apiFetch<ChatMessage>(`/team-chat/threads/${threadId}/messages`, {
    method: 'POST',
    body: { text, clientId },
  });

export function sendTeamMedia(
  threadId: number,
  file: File,
  kind: ChatMessageType,
  clientId: string,
) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  fd.append('clientId', clientId);
  return postMultipart<ChatMessage>(`/team-chat/threads/${threadId}/media`, fd);
}

export const markThreadRead = (threadId: number) =>
  apiFetch<{ ok: true }>(`/team-chat/threads/${threadId}/read`, { method: 'POST' });

export const markThreadDelivered = (threadId: number) =>
  apiFetch<{ ok: true }>(`/team-chat/threads/${threadId}/delivered`, { method: 'POST' });

export const sendTeamOrder = (
  threadId: number,
  order: OrderShare,
  clientId: string,
) =>
  apiFetch<ChatMessage>(`/team-chat/threads/${threadId}/order`, {
    method: 'POST',
    body: { ...order, clientId },
  });

export const sendTeamChat = (
  threadId: number,
  chat: ChatShare,
  clientId: string,
) =>
  apiFetch<ChatMessage>(`/team-chat/threads/${threadId}/chat`, {
    method: 'POST',
    body: { ...chat, clientId },
  });

/** Resolve a CodesApp order by its number (universal mirror lookup) to build a
 *  share card. Returns null if not found. */
export async function lookupOrder(number: string): Promise<OrderShare | null> {
  const n = number.replace(/[^0-9]/g, '');
  if (!n) return null;
  try {
    const r = await apiFetch<{
      order: {
        orderGid: string;
        orderName: string | null;
        orderNumber: number | string | null;
        customerName: string | null;
        totalPrice: number | null;
        currency: string | null;
        financialStatus: string | null;
        fulfillmentStatus: string | null;
      };
      lineItems: unknown[];
    }>(`/shopify/orders/detail?number=${encodeURIComponent(n)}`);
    const o = r.order;
    return {
      number: String(o.orderNumber ?? n),
      gid: o.orderGid ?? null,
      customerName: o.customerName ?? null,
      status: o.fulfillmentStatus || o.financialStatus || null,
      total: o.totalPrice ?? null,
      currency: o.currency ?? null,
      itemCount: Array.isArray(r.lineItems) ? r.lineItems.length : null,
    };
  } catch {
    return null;
  }
}
