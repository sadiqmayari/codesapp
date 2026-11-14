/**
 * Growth metric catalogue — the single definition of every number the module
 * shows. Served to the frontend (GET /growth/catalog) so tiles, "how is this
 * calculated" popovers, CSV headers and the AI's query tool all agree.
 */
export type MetricUnit = 'money' | 'ratio' | 'pct' | 'count' | 'days';

export interface MetricDef {
  id: string;
  label: string;
  unit: MetricUnit;
  /** true = higher is better (drives delta colour). */
  higherIsBetter: boolean;
  formula: string;
  description: string;
}

export const METRICS: MetricDef[] = [
  { id: 'gross', label: 'Gross sales', unit: 'money', higherIsBetter: true, formula: 'Σ item value before discounts, every order placed',
    description: 'Every order placed in the period at item value before discounts, including ones later cancelled or returned. No shipping or tax.' },
  { id: 'net', label: 'Net sales', unit: 'money', higherIsBetter: true, formula: 'gross − discounts − cancelled − returned',
    description: 'Gross minus discounts, minus orders cancelled before shipping, minus parcels that came back. Includes parcels still on the way.' },
  { id: 'discounts', label: 'Discounts', unit: 'money', higherIsBetter: false, formula: 'Σ order discounts',
    description: 'Discount codes, automatic and line discounts given on orders placed in the period.' },
  { id: 'cancelledValue', label: 'Cancelled', unit: 'money', higherIsBetter: false, formula: 'Σ after-discount value of orders cancelled before shipping',
    description: 'Orders cancelled without being returned, at their after-discount value.' },
  { id: 'returnedValue', label: 'Returned (RTO)', unit: 'money', higherIsBetter: false, formula: 'Σ after-discount value of returned parcels',
    description: 'Orders whose parcel came back, at their after-discount value.' },
  { id: 'realized', label: 'Realized', unit: 'money', higherIsBetter: true, formula: 'Σ subtotal of delivered orders',
    description: 'Revenue from parcels already delivered — money you will actually collect.' },
  { id: 'pending', label: 'Pending', unit: 'money', higherIsBetter: true, formula: 'Σ subtotal of unconfirmed, awaiting-booking and in-transit orders',
    description: 'Orders still in flight. Part of this will be cancelled or returned.' },
  { id: 'expected', label: 'Expected net', unit: 'money', higherIsBetter: true, formula: 'Σ subtotal × P(delivered)',
    description: 'Realized revenue plus in-flight orders weighted by their delivery probability (your history by city, payment and confirmation stage).' },
  { id: 'spend', label: 'Ad spend', unit: 'money', higherIsBetter: false, formula: 'Σ platform spend × daily FX rate',
    description: 'Spend on every connected ad platform, converted to your store currency.' },
  { id: 'mer', label: 'MER', unit: 'pct', higherIsBetter: false, formula: 'ad spend ÷ gross sales',
    description: 'Marketing efficiency ratio: the share of gross sales spent on ads. Lower is better.' },
  { id: 'roas', label: 'Blended ROAS', unit: 'ratio', higherIsBetter: true, formula: 'net sales ÷ ad spend',
    description: 'Net sales per unit of ad spend, regardless of which ad gets the credit.' },
  { id: 'expRoas', label: 'Expected ROAS', unit: 'ratio', higherIsBetter: true, formula: 'expected net ÷ ad spend',
    description: 'ROAS after predicted cancellations and returns. The most honest ROAS for COD stores.' },
  { id: 'platformRoas', label: 'Platform ROAS', unit: 'ratio', higherIsBetter: true, formula: 'Σ platform purchase value ÷ ad spend',
    description: 'What the ad platforms report. Counts placed orders, so it runs high for COD.' },
  { id: 'breakEvenRoas', label: 'Break-even ROAS', unit: 'ratio', higherIsBetter: false, formula: 'net ÷ (net − COGS − shipping − fees)',
    description: 'The ROAS at which ads stop making money once product, shipping and payment costs are paid.' },
  { id: 'orders', label: 'Orders', unit: 'count', higherIsBetter: true, formula: 'count of non-cancelled orders',
    description: 'Orders placed and not cancelled.' },
  { id: 'aov', label: 'AOV', unit: 'money', higherIsBetter: true, formula: 'gross of non-cancelled orders ÷ orders',
    description: 'Average order value, excluding cancelled orders.' },
  { id: 'newCustomers', label: 'New customers', unit: 'count', higherIsBetter: true, formula: 'customers whose first non-cancelled order is in the period',
    description: 'First-time buyers, matched by phone (last 10 digits) or email across all your stores.' },
  { id: 'ncac', label: 'nCAC', unit: 'money', higherIsBetter: false, formula: 'ad spend ÷ new customers',
    description: 'What it costs in ads to win one new customer.' },
  { id: 'rtoRate', label: 'RTO rate', unit: 'pct', higherIsBetter: false, formula: 'returned ÷ (delivered + returned)',
    description: 'Share of shipped parcels that came back.' },
  { id: 'cancelRate', label: 'Cancel rate', unit: 'pct', higherIsBetter: false, formula: 'cancelled ÷ placed',
    description: 'Share of placed orders that were cancelled.' },
  { id: 'cogs', label: 'COGS', unit: 'money', higherIsBetter: false, formula: 'Σ units × cost price (bundles = their components)',
    description: 'Product cost of kept orders, from your cost prices (CodesApp or Shopify cost per item).' },
  { id: 'shipping', label: 'Shipping', unit: 'money', higherIsBetter: false, formula: 'courier invoice amount, else your per-courier average',
    description: 'Courier charges from imported invoices; estimated from your average rate until an invoice arrives.' },
  { id: 'fees', label: 'Payment fees', unit: 'money', higherIsBetter: false, formula: 'settlement fee share, else your average gateway fee rate',
    description: 'Gateway fees (e.g. PayFast) from settlement statements.' },
  { id: 'grossProfit', label: 'Gross profit', unit: 'money', higherIsBetter: true, formula: 'net sales − COGS',
    description: 'Net sales minus product cost.' },
  { id: 'netProfit', label: 'Net profit', unit: 'money', higherIsBetter: true, formula: 'net − COGS − ad spend − shipping − fees',
    description: 'What is left after product, ads, shipping and payment fees.' },
  { id: 'expectedProfit', label: 'Expected profit', unit: 'money', higherIsBetter: true, formula: 'Σ(net × P) − Σ(COGS × P) − ad spend − shipping − fees',
    description: 'Net profit after predicted cancellations and returns.' },
  { id: 'netMargin', label: 'Net margin', unit: 'pct', higherIsBetter: true, formula: 'net profit ÷ net sales',
    description: 'Net profit as a share of net sales.' },
  { id: 'ctr', label: 'CTR', unit: 'pct', higherIsBetter: true, formula: 'link clicks ÷ impressions', description: 'Click-through rate on links.' },
  { id: 'cpm', label: 'CPM', unit: 'money', higherIsBetter: false, formula: 'spend ÷ impressions × 1000', description: 'Cost per thousand impressions.' },
  { id: 'cpc', label: 'CPC', unit: 'money', higherIsBetter: false, formula: 'spend ÷ link clicks', description: 'Cost per link click.' },
  { id: 'cpa', label: 'CPA', unit: 'money', higherIsBetter: false, formula: 'spend ÷ attributed orders', description: 'Ad spend per attributed order.' },
  { id: 'frequency', label: 'Frequency', unit: 'ratio', higherIsBetter: false, formula: 'impressions ÷ reach (daily reach summed)',
    description: 'Average times a person saw the ad. Above ~3 usually means fatigue.' },
  { id: 'hookRate', label: 'Hook rate', unit: 'pct', higherIsBetter: true, formula: '3-second views ÷ impressions',
    description: 'How often a video stopped the scroll.' },
  { id: 'holdRate', label: 'Hold rate', unit: 'pct', higherIsBetter: true, formula: 'ThruPlays ÷ 3-second views',
    description: 'How often people kept watching after the hook.' },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));
