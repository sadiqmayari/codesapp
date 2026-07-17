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
  // Structured preview of the latest message (for the WhatsApp-style list row:
  // media icon+label + outbound delivery tick). Additive/optional — realtime
  // splices set what the socket payload carries; a full REST load fills all.
  last_message_type?: MessageType | null;
  last_message_direction?: 'inbound' | 'outbound' | null;
  last_message_status?: MessageStatus | null;
  unread_count: number;
  window_expires_at: string | null;
  pinned_at: string | null;
  ai_autoreply: boolean | null;
  updated_at: string;
}

/** Click-to-WhatsApp attribution captured from the Meta `referral` object. */
export interface ConversationReferral {
  source_type: string | null; // 'ad' | 'post'
  source_id: string | null;
  source_url: string | null;
  headline: string | null;
  body: string | null;
  media_type: string | null;
  image_url: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  /** Our persistent copy (web path) of the ad thumbnail; null → use *_url. */
  thumb_path: string | null;
  ctwa_clid: string | null;
  received_at: string | null;
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
  referral?: ConversationReferral | null;
}

export type MessageDirection = 'inbound' | 'outbound';
// 'sending' is a client-only optimistic state (shown instantly before the
// server/Meta round-trip confirms). The backend never sends it.
export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'played'
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
  /** Cached Whisper transcription of a voice note (message_type='audio'). */
  transcription?: string | null;
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
