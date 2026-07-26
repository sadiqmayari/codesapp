import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { SHOPIFY_API_VERSIONS } from '../integrations/shopify/shopify.service';

// Same default the Shopify module uses, so a version bump there applies here
// too rather than silently drifting to an older API.
const DEFAULT_API_VERSION = SHOPIFY_API_VERSIONS[0];
const TIMEOUT_MS = 10_000;

export interface ShopifyOrderForBooking {
  orderGid: string;
  orderName: string;
  fulfillmentOrderId: string | null;
  shipping: {
    name: string;
    phone: string;
    city: string;
    address1: string;
    address2: string | null;
  } | null;
  lineItemsSummary: string;
}

/**
 * Small, self-contained Shopify Admin GraphQL client scoped to what courier
 * booking/tracking needs (order lookup, fulfillmentCreate, fulfillmentEventCreate,
 * tag mutations). Deliberately does NOT reach into the existing 5800-line
 * ShopifyService (whose GraphQL helper + admin-api resolution are private) —
 * reads the same `Company.shopify_admin_token_encrypted` /
 * `ShopifyOrderConfig.shop_domain` fields it already uses, so no schema
 * duplication, just a narrower client for this module.
 */
@Injectable()
export class ShopifyFulfillmentClient {
  private readonly logger = new Logger(ShopifyFulfillmentClient.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private async getAdminApi(
    companyId: number,
  ): Promise<{ token: string; shopDomain: string; apiVersion: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopify_admin_token_encrypted: true },
    });
    if (!company?.shopify_admin_token_encrypted) {
      throw new BadRequestException(
        'No Shopify Admin API token configured. Add it in Settings > Shopify.',
      );
    }
    const token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
      select: { shop_domain: true, api_version: true },
    });
    const shopDomain = (cfg?.shop_domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!shopDomain) {
      throw new BadRequestException(
        'No Shopify store domain set. Add it in Settings > Shopify.',
      );
    }
    return { token, shopDomain, apiVersion: cfg?.api_version || DEFAULT_API_VERSION };
  }

  private async graphql<T>(
    companyId: number,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const api = await this.getAdminApi(companyId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://${api.shopDomain}/admin/api/${api.apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'x-shopify-access-token': api.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        },
      );
      const json = (await res.json()) as T;
      if (!res.ok) {
        throw new Error(`Shopify API ${res.status}: ${JSON.stringify(json)}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async getOrderForBooking(
    companyId: number,
    orderName: string,
  ): Promise<ShopifyOrderForBooking | null> {
    const digits = orderName.replace(/[^0-9]/g, '');
    if (!digits) return null;
    type Res = {
      data?: {
        orders?: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              phone: string | null;
              shippingAddress: {
                name: string | null;
                phone: string | null;
                city: string | null;
                address1: string | null;
                address2: string | null;
              } | null;
              lineItems: { edges: Array<{ node: { title: string; quantity: number } }> };
              fulfillmentOrders: { edges: Array<{ node: { id: string; status: string } }> };
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    const res = await this.graphql<Res>(
      companyId,
      `query($q: String) {
        orders(first: 1, query: $q) {
          edges { node {
            id
            name
            phone
            shippingAddress { name phone city address1 address2 }
            lineItems(first: 50) { edges { node { title quantity } } }
            fulfillmentOrders(first: 5) { edges { node { id status } } }
          } }
        }
      }`,
      { q: `name:#${digits}` },
    );
    const node = res?.data?.orders?.edges?.[0]?.node;
    if (!node) return null;

    const openFo = node.fulfillmentOrders.edges.find(
      (e) => e.node.status !== 'CLOSED' && e.node.status !== 'CANCELLED',
    );
    const addr = node.shippingAddress;
    return {
      orderGid: node.id,
      orderName: node.name,
      fulfillmentOrderId: openFo?.node.id ?? null,
      shipping: addr
        ? {
            name: addr.name || '',
            phone: addr.phone || node.phone || '',
            city: addr.city || '',
            address1: addr.address1 || '',
            address2: addr.address2,
          }
        : null,
      lineItemsSummary: node.lineItems.edges
        .map((e) => `${e.node.quantity}x ${e.node.title}`)
        .join(', '),
    };
  }

  async createFulfillment(
    companyId: number,
    fulfillmentOrderId: string,
    trackingNumber: string,
    trackingCompany: string,
    trackingUrl?: string,
  ): Promise<{ fulfillmentId: string | null; errors: string[] }> {
    type Res = {
      data?: {
        fulfillmentCreate?: {
          fulfillment?: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      };
    };
    const res = await this.graphql<Res>(
      companyId,
      `mutation($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id }
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
          trackingInfo: {
            number: trackingNumber,
            company: trackingCompany,
            url: trackingUrl,
          },
          notifyCustomer: false,
        },
      },
    );
    const errors = res?.data?.fulfillmentCreate?.userErrors?.map((e) => e.message) ?? [];
    return { fulfillmentId: res?.data?.fulfillmentCreate?.fulfillment?.id ?? null, errors };
  }

  /** Cancel a fulfillment (undo a booking). Returns the fulfillment's new
   *  status, or the userErrors if Shopify refused. Best-effort — callers wrap. */
  async cancelFulfillment(
    companyId: number,
    fulfillmentId: string,
  ): Promise<{ ok: boolean; errors: string[] }> {
    type Res = {
      data?: {
        fulfillmentCancel?: {
          fulfillment?: { id: string; status: string } | null;
          userErrors: Array<{ message: string }>;
        };
      };
    };
    const res = await this.graphql<Res>(
      companyId,
      `mutation($id: ID!) {
        fulfillmentCancel(id: $id) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      { id: fulfillmentId },
    );
    const errors = res?.data?.fulfillmentCancel?.userErrors?.map((e) => e.message) ?? [];
    return { ok: errors.length === 0, errors };
  }

  async createFulfillmentEvent(
    companyId: number,
    fulfillmentId: string,
    status: string,
    message?: string,
  ): Promise<void> {
    type Res = {
      data?: { fulfillmentEventCreate?: { userErrors: Array<{ message: string }> } };
    };
    const res = await this.graphql<Res>(
      companyId,
      `mutation($event: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $event) {
          userErrors { field message }
        }
      }`,
      { event: { fulfillmentId, status, message } },
    );
    const errors = res?.data?.fulfillmentEventCreate?.userErrors ?? [];
    if (errors.length) {
      this.logger.warn(
        `fulfillmentEventCreate userErrors (company ${companyId}, status ${status}): ${errors
          .map((e) => e.message)
          .join('; ')}`,
      );
    }
  }

  /** Two separate requests (remove then add), each declaring only the
   *  variable it uses — see CLAUDE.md's note on why a combined tagsAdd+
   *  tagsRemove mutation silently drops add-only calls. */
  async tagOrder(
    companyId: number,
    orderGid: string,
    addTags: string[],
    removeTags: string[],
  ): Promise<void> {
    if (removeTags.length) {
      await this.graphql(
        companyId,
        `mutation($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { id: orderGid, tags: removeTags },
      );
    }
    if (addTags.length) {
      await this.graphql(
        companyId,
        `mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { id: orderGid, tags: addTags },
      );
    }
  }
}
