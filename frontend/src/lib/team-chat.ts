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

export type ChatMessageType = 'text' | 'image' | 'audio' | 'file';

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

export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor: number | null;
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
