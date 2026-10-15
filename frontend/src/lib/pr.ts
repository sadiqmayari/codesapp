import { apiFetch } from '@/lib/api';

export type PrSubmissionStatus = 'new' | 'approved' | 'declined' | 'sent';

export interface PrCampaign {
  id: number;
  company_id: number;
  name: string;
  intro: string | null;
  public_token: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  _count?: { submissions: number };
}

export interface PrSubmission {
  id: number;
  company_id: number;
  campaign_id: number;
  influencer_name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  instagram: string | null;
  tiktok: string | null;
  follower_count: number | null;
  product_wishlist: string | null;
  status: PrSubmissionStatus;
  decided_by_user_id: number | null;
  decided_at: string | null;
  shopify_order_gid: string | null;
  order_name: string | null;
  created_at: string;
  campaign?: { id: number; name: string };
}

export interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

// ── Campaigns ────────────────────────────────────────────────────────────────
export function listCampaigns(): Promise<PrCampaign[]> {
  return apiFetch<PrCampaign[]>('/pr/campaigns');
}
export function createCampaign(body: {
  name: string;
  intro?: string;
}): Promise<PrCampaign> {
  return apiFetch<PrCampaign>('/pr/campaigns', { method: 'POST', body });
}
export function updateCampaign(
  id: number,
  body: { name?: string; intro?: string; active?: boolean },
): Promise<PrCampaign> {
  return apiFetch<PrCampaign>(`/pr/campaigns/${id}`, { method: 'PATCH', body });
}
export function deleteCampaign(id: number): Promise<unknown> {
  return apiFetch(`/pr/campaigns/${id}`, { method: 'DELETE' });
}

// ── Submissions ────────────────────────────────────────────────────────────────
export function listSubmissions(filter?: {
  campaignId?: number;
  status?: string;
}): Promise<PrSubmission[]> {
  const q = new URLSearchParams();
  if (filter?.campaignId) q.set('campaignId', String(filter.campaignId));
  if (filter?.status && filter.status !== 'all') q.set('status', filter.status);
  const qs = q.toString();
  return apiFetch<PrSubmission[]>(`/pr/submissions${qs ? `?${qs}` : ''}`);
}
export function decideSubmission(
  id: number,
  decision: 'approved' | 'declined',
): Promise<PrSubmission> {
  return apiFetch<PrSubmission>(`/pr/submissions/${id}/decide`, {
    method: 'PATCH',
    body: { decision },
  });
}
export function sendPackage(
  id: number,
  lineItems: { variantId: string; quantity: number }[],
  opts?: { countryCode?: string; storeId?: number },
): Promise<{ order: { orderName: string; adminUrl: string } }> {
  return apiFetch(`/pr/submissions/${id}/send-package`, {
    method: 'POST',
    body: { lineItems, ...opts },
  });
}

export function searchProducts(query: string): Promise<ProductVariant[]> {
  return apiFetch<ProductVariant[]>('/shopify/products', { params: { query } });
}

// ── Public submission link ────────────────────────────────────────────────────
export function publicFormUrl(token: string): string {
  if (typeof window === 'undefined') return `/pr-apply/${token}`;
  return `${window.location.origin}/pr-apply/${token}`;
}

export const SUBMISSION_STATUS_META: Record<
  PrSubmissionStatus,
  { label: string; cls: string }
> = {
  new: { label: 'New', cls: 'bg-blue-100 text-blue-700' },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-700' },
  declined: { label: 'Declined', cls: 'bg-gray-200 text-gray-600' },
  sent: { label: 'Package sent', cls: 'bg-violet-100 text-violet-700' },
};
