import { apiFetch, postMultipart } from '@/lib/api';

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

export const TICKET_TYPES = [
  'refund',
  'return',
  'exchange',
  'damaged',
  'wrong_item',
  'missing',
  'complaint',
  'other',
] as const;

/** Agent-created (manual) ticket — always tied to a conversation. */
export function createTicket(body: {
  conversationId: number;
  type: string;
  description?: string;
  linkedOrderName?: string;
  assignedUserId?: number;
}): Promise<TicketDetail> {
  return apiFetch('/tickets', { method: 'POST', body });
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

// ── Replacement shipments (PostEx/Trax etc., booked from a ticket) ──────────

export interface ReplacementCourierOption {
  courierType: string;
  label: string;
  /** Whether this courier serves the order's destination city. */
  serves: boolean;
}

export interface ReplacementRow {
  id: number;
  courierType: string;
  courierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  city: string | null;
  createdAt: string;
}

export interface ReplacementContext {
  ticket: {
    id: number;
    ticketNumber: string;
    type: string;
    linkedOrderName: string | null;
  };
  prefill: {
    name: string;
    phone: string;
    email: string;
    city: string;
    address1: string;
    address2: string;
    contents: string;
    orderTotal: number | null;
    currency: string | null;
  };
  couriers: ReplacementCourierOption[];
  replacements: ReplacementRow[];
}

/** Pre-fill + courier options + already-booked replacements for a ticket. */
export function getReplacementContext(
  ticketId: number,
): Promise<ReplacementContext> {
  return apiFetch(`/shipments/replacement/context/${ticketId}`);
}

export interface CreateReplacementBody {
  ticketId: number;
  courierType: string;
  name: string;
  phone: string;
  city: string;
  address1: string;
  address2?: string;
  /** The item being SENT to the customer. */
  contents: string;
  codAmount: number;
  email?: string;
  // Item being TAKEN BACK (required for a Trax replacement).
  returnItemDescription?: string;
  returnItemQuantity?: number;
  /** Optional photo of the item to be picked up (Trax Replacement_item_image). */
  returnImage?: File | null;
}

export interface BookedReplacement {
  id: number;
  courierType: string;
  courierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
}

/** Book a replacement parcel for a ticket on the chosen courier. Sent as
 *  multipart so the (optional) return-item photo rides along for Trax. */
export function bookReplacementShipment(
  body: CreateReplacementBody,
): Promise<{ shipment: BookedReplacement }> {
  const fd = new FormData();
  fd.append('ticketId', String(body.ticketId));
  fd.append('courierType', body.courierType);
  fd.append('name', body.name);
  fd.append('phone', body.phone);
  fd.append('city', body.city);
  fd.append('address1', body.address1);
  if (body.address2) fd.append('address2', body.address2);
  fd.append('contents', body.contents);
  fd.append('codAmount', String(body.codAmount));
  if (body.email) fd.append('email', body.email);
  if (body.returnItemDescription)
    fd.append('returnItemDescription', body.returnItemDescription);
  if (body.returnItemQuantity != null)
    fd.append('returnItemQuantity', String(body.returnItemQuantity));
  if (body.returnImage) fd.append('returnImage', body.returnImage);
  return postMultipart<{ shipment: BookedReplacement }>(
    '/shipments/replacement',
    fd,
  );
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
