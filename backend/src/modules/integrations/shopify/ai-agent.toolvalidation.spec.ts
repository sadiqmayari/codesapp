import { AiAgentService } from './ai-agent.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';

/**
 * Integration tests for the Tool Validation wiring in executeTool (#increment 5).
 * Calls the private executeTool directly with a mocked Shopify so both states of
 * the flag are exercised: ON → malformed tool output is sanitized before the
 * model sees it; OFF → raw formatting (existing behavior) is preserved.
 */
describe('AiAgentService — tool validation in executeTool', () => {
  const JOB = { companyId: 7, conversationId: 100, messageId: 5 };
  const ctx = { contactPhone: '+923171263292' } as any;

  function makeAgent(shopify: any) {
    const noop = {} as any;
    return new AiAgentService(
      noop, noop, noop, noop, shopify, noop, noop, noop, noop, noop,
      noop, noop, noop, noop, noop, noop, noop, noop, noop,
      new ToolValidatorService(), noop /* imageRouter */, noop /* handoffSla */,
      noop /* convoState */, noop /* stateMachine */, noop /* confidence */,
    );
  }

  function route(toolValidation: boolean) {
    return {
      toolValidation,
      engWorkItemId: null,
      defaultCountryCode: 'PK',
      toolsUsed: [],
      toolFailures: 0,
    } as any;
  }

  describe('search_products', () => {
    const shopify = {
      searchProducts: jest.fn(async () => [
        { productTitle: 'Good', variantTitle: '', price: 1500, available: true, productUrl: '' },
        { productTitle: 'Priceless', variantTitle: '', price: 0, available: true, productUrl: '' },
      ]),
    };

    it('drops the priceless product when validation is ON', async () => {
      const svc = makeAgent(shopify);
      const out = await (svc as any).executeTool(
        JOB, ctx, route(true), 'search_products', { query: 'x' },
      );
      const parsed = JSON.parse(out);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].product).toBe('Good');
    });

    it('keeps raw output (incl. priceless) when validation is OFF', async () => {
      const svc = makeAgent(shopify);
      const out = await (svc as any).executeTool(
        JOB, ctx, route(false), 'search_products', { query: 'x' },
      );
      expect(JSON.parse(out)).toHaveLength(2);
    });
  });

  describe('get_order_status', () => {
    const shopify = {
      getOrderStatus: jest.fn(async () => ({
        found: true,
        name: '#1001',
        fulfillmentStatus: 'fulfilled',
        tracking: [{ company: '', number: 'N/A', url: '' }], // placeholder only
        customerPhone: '+923171263292', // matches ctx.contactPhone → ownership ok
        shippingPhone: null,
      })),
    };

    it('strips placeholder tracking when validation is ON', async () => {
      const svc = makeAgent(shopify);
      const out = await (svc as any).executeTool(
        JOB, ctx, route(true), 'get_order_status', { order_number: '1001' },
      );
      const parsed = JSON.parse(out);
      expect(parsed.tracking).toHaveLength(0);
    });

    it('keeps the raw placeholder tracking when validation is OFF', async () => {
      const svc = makeAgent(shopify);
      const out = await (svc as any).executeTool(
        JOB, ctx, route(false), 'get_order_status', { order_number: '1001' },
      );
      const parsed = JSON.parse(out);
      expect(parsed.tracking).toEqual(['N/A']);
    });
  });
});
