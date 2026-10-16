import { apiFetch } from '@/lib/api';

export type PrSubmissionStatus = 'new' | 'approved' | 'declined' | 'sent';

export type OutcomeStatus = 'pending' | 'posted' | 'no_show';
export type InfluencerStatus = 'active' | 'vip' | 'blacklisted';

export interface PrFormData {
  category?: string;
  videoTypes?: string[];
  about?: string;
  whyCollaborate?: string;
  contentPlan?: string;
  videosCount?: string;
  productPreference?: string | null;
  followersText?: string;
  address?: {
    name?: string;
    number?: string;
    house?: string;
    street?: string;
    landmark?: string;
    city?: string;
  };
  adsConsent?: boolean;
  termsConsent?: boolean;
}

export interface PrCampaign {
  id: number;
  company_id: number;
  name: string;
  slug: string | null;
  intro: string | null;
  terms: string | null;
  public_token: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  _count?: { submissions: number };
  company_public_slug?: string | null;
}

export interface PrSubmission {
  id: number;
  company_id: number;
  campaign_id: number;
  influencer_id: number | null;
  influencer_name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  instagram: string | null;
  tiktok: string | null;
  follower_count: number | null;
  product_wishlist: string | null;
  form_data: PrFormData | null;
  status: PrSubmissionStatus;
  decided_by_user_id: number | null;
  decided_at: string | null;
  shopify_order_gid: string | null;
  order_name: string | null;
  outcome: OutcomeStatus | null;
  post_url: string | null;
  posted_at: string | null;
  created_at: string;
  campaign?: { id: number; name: string };
}

export interface PrInfluencer {
  id: number;
  company_id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  instagram: string | null;
  tiktok: string | null;
  other_social: string | null;
  follower_count: number | null;
  niche: string | null;
  status: InfluencerStatus;
  notes: string | null;
  tags: string[] | null;
  packages_count: number;
  last_package_at: string | null;
  created_at: string;
  updated_at: string;
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
  terms?: string;
}): Promise<PrCampaign> {
  return apiFetch<PrCampaign>('/pr/campaigns', { method: 'POST', body });
}
export function updateCampaign(
  id: number,
  body: { name?: string; intro?: string; terms?: string; active?: boolean },
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
/**
 * The influencer form URL. Prefers the branded subdomain
 * pr.codentra.pk/<tenant>/<campaign> when the tenant has a public slug and the
 * campaign has a slug; otherwise falls back to the legacy token link.
 */
export function publicFormUrl(c: PrCampaign): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  if (c.company_public_slug && c.slug) {
    return `https://pr.codentra.pk/${c.company_public_slug}/${c.slug}`;
  }
  return `${origin}/pr-apply/${c.public_token}`;
}

// ── Influencer CRM ────────────────────────────────────────────────────────────
export function listInfluencers(filter?: {
  status?: string;
  q?: string;
}): Promise<PrInfluencer[]> {
  const q = new URLSearchParams();
  if (filter?.status && filter.status !== 'all') q.set('status', filter.status);
  if (filter?.q) q.set('q', filter.q);
  const qs = q.toString();
  return apiFetch<PrInfluencer[]>(`/pr/influencers${qs ? `?${qs}` : ''}`);
}

export function getInfluencer(
  id: number,
): Promise<{ profile: PrInfluencer; submissions: PrSubmission[] }> {
  return apiFetch(`/pr/influencers/${id}`);
}

export function updateInfluencer(
  id: number,
  patch: Partial<
    Pick<
      PrInfluencer,
      | 'name' | 'phone' | 'email' | 'city' | 'address' | 'instagram'
      | 'tiktok' | 'other_social' | 'follower_count' | 'niche' | 'status'
      | 'notes' | 'tags'
    >
  >,
): Promise<PrInfluencer> {
  return apiFetch(`/pr/influencers/${id}`, { method: 'PATCH', body: patch });
}

export function setSubmissionOutcome(
  id: number,
  outcome: OutcomeStatus,
  postUrl?: string,
): Promise<PrSubmission> {
  return apiFetch(`/pr/submissions/${id}/outcome`, {
    method: 'PATCH',
    body: { outcome, postUrl },
  });
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

export const INFLUENCER_STATUS_META: Record<
  InfluencerStatus,
  { label: string; cls: string }
> = {
  active: { label: 'Active', cls: 'bg-green-100 text-green-700' },
  vip: { label: 'VIP', cls: 'bg-amber-100 text-amber-700' },
  blacklisted: { label: 'Blacklisted', cls: 'bg-red-100 text-red-700' },
};
