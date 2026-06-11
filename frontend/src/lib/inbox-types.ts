export interface ContactLite {
  id: number;
  name: string;
  phone: string;
  email: string | null;
}

export interface AssignedUser {
  id: number;
  name: string;
  email: string;
}

export interface ConversationRow {
  id: number;
  contact: ContactLite;
  assigned_user: AssignedUser | null;
  labels: { label: string }[];
  status: 'open' | 'resolved' | 'pending';
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  window_expires_at: string | null;
  pinned_at: string | null;
  ai_autoreply: boolean | null;
  updated_at: string;
}

export interface ConversationDetail {
  id: number;
  contact: ContactLite & {
    tags?: unknown;
    status?: 'active' | 'blocked' | 'archived';
  };
  assigned_user: AssignedUser | null;
  labels: { id: number; label: string }[];
  status: 'open' | 'resolved' | 'pending';
  window_expires_at: string | null;
  pinned_at: string | null;
  cleared_before: string | null;
  ai_autoreply: boolean | null;
  contact_id: number;
}

export type MessageDirection = 'inbound' | 'outbound';
// 'sending' is a client-only optimistic state (shown instantly before the
// server/Meta round-trip confirms). The backend never sends it.
export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'template'
  | 'sticker';

export interface Message {
  id: number;
  /** Client-only id for an optimistic (not-yet-confirmed) outbound message. */
  client_id?: string;
  conversation_id: number;
  message_type: MessageType;
  direction: MessageDirection;
  content: string | null;
  media_url: string | null;
  media_expired: boolean;
  status: MessageStatus;
  read_at: string | null;
  /** Customer's emoji reaction on this message (WhatsApp-style badge). */
  reaction?: string | null;
  timestamp: string;
  created_at: string;
  error?: string | null;
  context_message_id?: number | null;
  context_message?: {
    id: number;
    direction: 'inbound' | 'outbound';
    message_type: string;
    content?: string | null;
    media_url?: string | null;
  } | null;
}

export interface ConversationNote {
  id: number;
  user_id: number;
  body: string;
  created_at: string;
}

export interface TemplateItem {
  id: number;
  name: string;
  category: string;
  status: string;
  content: {
    language?: string;
    components?: Array<{
      type: string;
      text?: string;
      format?: string;
    }>;
  };
}
