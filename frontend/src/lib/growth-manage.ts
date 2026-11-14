import { apiFetch, postMultipart } from '@/lib/api';

/** Growth ad management (owner/admin). Every write goes preview → publish (logged, undoable). */

export type EntityLevel = 'campaign' | 'adset' | 'ad';
export type BidStrategy = 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_MIN_ROAS' | 'LOWEST_COST_WITH_BID_CAP';
export type OptimizationGoal = 'OFFSITE_CONVERSIONS' | 'VALUE' | 'CONVERSATIONS' | 'LANDING_PAGE_VIEWS' | 'LINK_CLICKS' | 'REACH';
export type AttributionWindow = '7d_click_1d_view' | '7d_click' | '1d_click';

export interface EntityPatch {
  status?: 'ACTIVE' | 'PAUSED';
  name?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  bidStrategy?: BidStrategy;
  bidAmount?: number | null;
  roasFloor?: number | null;
  optimizationGoal?: OptimizationGoal;
  conversionEvent?: string;
  attributionWindow?: AttributionWindow;
  endTime?: string | null;
}

export type Change =
  | { kind: 'patch'; level: EntityLevel; entityId: string; patch: EntityPatch }
  | { kind: 'scale'; campaignId: string; pct: number };

export interface PreviewItem {
  level: EntityLevel;
  entityId: string;
  entityName: string | null;
  before: EntityPatch;
  after: EntityPatch;
  error: string | null;
  spendDeltaMonthly: number | null;
  expectedNetDeltaMonthly: number | null;
  roasAfter: number | null;
  warnings: string[];
  stats: { platformCpa: number | null; platformRoas: number | null };
}

export interface PublishResult {
  batchId: string;
  ok: boolean;
  results: Array<{ logId: number; entityId: string; entityName: string | null; ok: boolean; error?: string }>;
}

export interface EntitySettings {
  level: EntityLevel;
  entityId: string;
  name: string | null;
  platform: string;
  accountId: number;
  snapshot: EntityPatch;
  status: string | null;
  objective: string | null;
  budgetOwner: string | null;
  budgetType: string | null;
  destinationType: string | null;
  campaignId: string | null;
  childGoals: Array<{ id: string; name: string | null; optimizationGoal: string | null }>;
  stats: { platformCpa: number | null; platformRoas: number | null; dailySpend: number };
}

export interface ChangeLogRow {
  id: number;
  batchId: string | null;
  action: string;
  level: EntityLevel;
  entityId: string;
  entityName: string | null;
  userName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  result: 'pending' | 'ok' | 'failed';
  error: string | null;
  undoOfId: number | null;
  undoneAt: string | null;
  createdAt: string;
  canUndo: boolean;
}

export interface AccessRow {
  accountId: number;
  platform: string;
  name: string | null;
  canManage: boolean;
  missing: string[];
  granted?: string[];
  reason: string | null;
}

export interface Benchmarks {
  days: number;
  dailySpend: number;
  platformCpa: number | null;
  costPerConversation: number | null;
  costPerLinkClick: number | null;
  purchasesPerDay: number;
  platformRoas: number | null;
  expRoas: number | null;
  breakEvenRoas: number | null;
  placedFactor: number | null;
  breakEvenMetaRoas: number | null;
  rtoRate: number | null;
}

export interface CreateAssets {
  account: { id: number; name: string | null; currency: string | null; platform: string };
  pages: Array<{ id: string; name: string }>;
  instagram: Array<{ id: string; username: string }>;
  pixels: Array<{ id: string; name: string }>;
  whatsappNumbers: Array<{ id: number; number: string | null; label: string | null; primary: boolean }>;
  benchmarks: Benchmarks;
  riskyCities: Array<{ key: string; name: string; rate: number; lostMonthly: number }>;
}

export interface CreateDraft {
  name: string;
  objective: 'OUTCOME_SALES' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_TRAFFIC' | 'OUTCOME_LEADS' | 'OUTCOME_AWARENESS';
  cbo: boolean;
  budgetType: 'daily' | 'lifetime';
  budget: number;
  bidStrategy: BidStrategy;
  bidAmount?: number | null;
  roasFloor?: number | null;
  conversionLocation: 'website' | 'whatsapp';
  optimizationGoal: OptimizationGoal;
  conversionEvent?: string | null;
  attributionWindow: AttributionWindow;
  pixelId?: string | null;
  countries: string[];
  excludeCities: Array<{ key: string; name: string }>;
  ageMin: number;
  ageMax: number;
  genders: Array<1 | 2>;
  advantageAudience: boolean;
  advantagePlacements: boolean;
  startTime?: string | null;
  endTime?: string | null;
  pageId: string;
  instagramId?: string | null;
  whatsappNumber?: string | null;
  primaryText: string;
  headline: string;
  cta: string;
  url?: string | null;
  imageHash?: string | null;
  videoId?: string | null;
}

export const BID_LABEL: Record<BidStrategy, string> = {
  LOWEST_COST_WITHOUT_CAP: 'Highest volume',
  COST_CAP: 'Cost per result goal',
  LOWEST_COST_WITH_MIN_ROAS: 'ROAS goal',
  LOWEST_COST_WITH_BID_CAP: 'Bid cap',
};

export const BID_HINT: Record<BidStrategy, string> = {
  LOWEST_COST_WITHOUT_CAP: 'Get the most results for the budget. Best while learning.',
  COST_CAP: 'Keep the average cost per result around a target.',
  LOWEST_COST_WITH_MIN_ROAS: 'Keep return on ad spend above a floor. Needs value optimisation.',
  LOWEST_COST_WITH_BID_CAP: 'Never bid above a maximum in each auction.',
};

export const GOAL_LABEL: Record<OptimizationGoal, string> = {
  OFFSITE_CONVERSIONS: 'Maximise number of conversions',
  VALUE: 'Maximise value of conversions',
  CONVERSATIONS: 'Maximise conversations',
  LANDING_PAGE_VIEWS: 'Maximise landing page views',
  LINK_CLICKS: 'Maximise link clicks',
  REACH: 'Maximise reach',
};

export const EVENT_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase',
  INITIATED_CHECKOUT: 'Initiate checkout',
  ADD_TO_CART: 'Add to cart',
};

export const WINDOW_LABEL: Record<AttributionWindow, string> = {
  '7d_click_1d_view': '7-day click or 1-day view',
  '7d_click': '7-day click',
  '1d_click': '1-day click',
};

export const ACTION_LABEL: Record<string, string> = {
  pause: 'Paused',
  resume: 'Turned on',
  budget: 'Budget',
  bid: 'Bid strategy',
  optimization: 'Optimisation',
  rename: 'Renamed',
  schedule: 'Schedule',
  duplicate: 'Duplicated',
  create: 'Created',
  undo: 'Undo',
  edit: 'Edited',
};

export const growthManageApi = {
  access: () => apiFetch<AccessRow[]>('/growth/manage/access'),
  settings: (level: EntityLevel, entityId: string) => apiFetch<EntitySettings>('/growth/manage/settings', { params: { level, entityId } }),
  preview: (changes: Change[]) => apiFetch<{ items: PreviewItem[] }>('/growth/manage/preview', { method: 'POST', body: { changes } }),
  publish: (changes: Change[]) => apiFetch<PublishResult>('/growth/manage/publish', { method: 'POST', body: { changes } }),
  duplicate: (level: EntityLevel, entityId: string) =>
    apiFetch<{ newId: string; logId: number }>('/growth/manage/duplicate', { method: 'POST', body: { level, entityId } }),
  log: (entityId?: string, limit = 100) => apiFetch<ChangeLogRow[]>('/growth/manage/log', { params: { entityId, limit } }),
  undo: (t: { logId?: number; batchId?: string }) =>
    apiFetch<{ ok: boolean; results: Array<{ logId: number; ok: boolean; error?: string }> }>('/growth/manage/undo', { method: 'POST', body: t }),
  assets: (accountId: number) => apiFetch<CreateAssets>('/growth/create/assets', { params: { accountId } }),
  cities: (accountId: number, q: string, country = 'PK') =>
    apiFetch<Array<{ key: string; name: string; region: string }>>('/growth/create/cities', { params: { accountId, q, country } }),
  media: (accountId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return postMultipart<{ kind: 'image' | 'video'; imageHash?: string; videoId?: string }>(`/growth/create/media?accountId=${accountId}`, fd);
  },
  getDraft: () => apiFetch<{ payload: { accountId?: number; draft?: Partial<CreateDraft> }; updatedAt: string } | null>('/growth/create/draft'),
  saveDraft: (payload: Record<string, unknown> | null) => apiFetch('/growth/create/draft', { method: 'PUT', body: { payload } }),
  create: (accountId: number, draft: CreateDraft) =>
    apiFetch<{ ok: boolean; campaignId?: string; adsetId?: string; creativeId?: string; adId?: string; logId: number }>('/growth/create', {
      method: 'POST',
      body: { accountId, draft },
    }),
};

/** Human summary of a patch ("Budget 2,000 → 2,400 / day"). `cur` formats money. */
export function describePatch(p: EntityPatch, fmt: (v: number) => string): string[] {
  const out: string[] = [];
  if (p.status) out.push(p.status === 'ACTIVE' ? 'Turn on' : 'Pause');
  if (p.name != null) out.push(`Rename to “${p.name}”`);
  if (p.dailyBudget != null) out.push(`Daily budget ${fmt(p.dailyBudget)}`);
  if (p.lifetimeBudget != null) out.push(`Lifetime budget ${fmt(p.lifetimeBudget)}`);
  if (p.bidStrategy) out.push(BID_LABEL[p.bidStrategy]);
  if (p.bidAmount != null) out.push(`Cost goal ${fmt(p.bidAmount)}`);
  if (p.roasFloor != null) out.push(`ROAS goal ${p.roasFloor.toFixed(2)}×`);
  if (p.optimizationGoal) out.push(GOAL_LABEL[p.optimizationGoal]);
  if (p.conversionEvent) out.push(`Event: ${EVENT_LABEL[p.conversionEvent] ?? p.conversionEvent}`);
  if (p.attributionWindow) out.push(WINDOW_LABEL[p.attributionWindow]);
  if (p.endTime !== undefined) out.push(p.endTime ? `Ends ${p.endTime.slice(0, 10)}` : 'No end date');
  return out;
}
