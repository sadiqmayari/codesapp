import { apiFetch } from '@/lib/api';

export type TicketStatus =
  | 'open'
  | 'in_progress'
  | 'awaiting_customer'
  | 'resolved'
  | 'rejected';

export const TICKET_STATUSES: TicketStatus[] = [
  'open',
  'in_progress',
  'awaiting_customer',
  'resolved',
  'rejected',
];

export interface TicketEvent {
  id: number;
  ticket_id: number;
  kind: string;
  body: string | null;
  actor: 'ai' | 'agent' | 'customer';
  user_id: number | null;
  created_at: string;
}

export interface TicketListItem {
  id: number;
  ticket_number: string;
  conversation_id: number;
  type: string;
  status: TicketStatus;
  linked_order_name: string | null;
  created_by: 'ai' | 'agent';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  contact: { id: number; name: string; phone: string } | null;
  assigned_user: { id: number; name: string } | null;
}

export interface TicketDetail extends TicketListItem {
  description: string | null;
  resolution_note: string | null;
  contact_id: number;
  assigned_user_id: number | null;
  events: TicketEvent[];
}

export function listTickets(params?: {
  status?: string;
  type?: string;
}): Promise<TicketListItem[]> {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.type) q.set('type', params.type);
  const qs = q.toString();
  return apiFetch(`/tickets${qs ? `?${qs}` : ''}`);
}

export function getTicket(id: number): Promise<TicketDetail> {
  return apiFetch(`/tickets/${id}`);
}

export function getOpenTicketForConversation(
  conversationId: number,
): Promise<TicketListItem | null> {
  return apiFetch(`/tickets/conversation/${conversationId}`);
}

export function updateTicket(
  id: number,
  body: {
    status?: TicketStatus;
    assignedUserId?: number | null;
    resolutionNote?: string;
  },
): Promise<TicketDetail> {
  return apiFetch(`/tickets/${id}`, { method: 'PATCH', body });
}

export function addTicketNote(id: number, body: string): Promise<TicketDetail> {
  return apiFetch(`/tickets/${id}/events`, { method: 'POST', body: { body } });
}

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_customer: 'Awaiting customer',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export function ticketStatusLabel(s: string): string {
  return STATUS_LABEL[s as TicketStatus] ?? s;
}

export function ticketStatusColor(s: string): string {
  switch (s) {
    case 'open':
      return 'bg-amber-100 text-amber-800';
    case 'in_progress':
      return 'bg-blue-100 text-blue-800';
    case 'awaiting_customer':
      return 'bg-purple-100 text-purple-800';
    case 'resolved':
      return 'bg-green-100 text-green-800';
    case 'rejected':
      return 'bg-gray-200 text-gray-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function ticketTypeLabel(t: string): string {
  const map: Record<string, string> = {
    refund: 'Refund',
    return: 'Return',
    exchange: 'Exchange',
    damaged: 'Damaged',
    wrong_item: 'Wrong item',
    missing: 'Missing',
    complaint: 'Complaint',
    other: 'Other',
  };
  return map[t] ?? t;
}
