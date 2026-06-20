import { AiAgentService } from './ai-agent.service';
import { ComplianceGuardService } from '../../../common/services/compliance-guard.service';
import { FrustrationDetectorService } from '../../../common/services/frustration-detector.service';
import { FraudDetectorService } from '../../../common/services/fraud-detector.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';
import { ImageRouterService } from '../../../common/services/image-router.service';
import { ConversationStateMachine } from '../../../common/services/conversation-state-machine';
import { ResponseConfidenceService } from '../../../common/services/response-confidence.service';

/**
 * Integration tests for the response-confidence gate in process() (#increment 10):
 *   - a low-confidence commerce reply (ungrounded price) → handoff, not sent;
 *   - a confident reply → sent;
 *   - flag OFF → reply always sent (no gating).
 * Real detectors/state-machine/confidence are used; the rest is mocked.
 */
describe('AiAgentService — response confidence gate', () => {
  const JOB = { companyId: 7, conversationId: 100, messageId: 5 };

  function makeAgent(opts: { reply: string; intent: string; enabled: boolean }) {
    const ctx = {
      transcript: 'Customer: hello',
      contactLine: 'Customer: Test',
      contactName: 'Test',
      contactPhone: '+923171234567',
      hasCustomerText: true,
      customerQuery: 'hello',
      companyName: 'Sois',
      brandTone: null,
      langRule: 'English',
      tier: 'fast',
      autoOrderEnabled: false,
      defaultCountryCode: 'PK',
    };

    const prisma = {
      conversation: {
        findFirst: jest.fn(async () => ({
          ai_autoreply: null,
          ai_awaiting_payment_at: null,
          ai_closed_at: null,
          ai_active_topic: null,
          ai_topic_expires_at: null,
          ai_episode_started_at: null,
          ai_pending_order: null,
          contact_id: 1,
          company: {
            ai_auto_order_enabled: false,
            ai_auto_order_all_enabled: false,
            ai_autoreply_enabled: false,
          },
        })),
        update: jest.fn(async () => ({})),
      },
      message: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
      supportTicket: { findFirst: jest.fn(async () => null) },
      conversationLabel: { upsert: jest.fn(async () => ({})) },
    } as any;

    const ai = {
      buildAgentContext: jest.fn(async () => ({ ...ctx })),
      classifyIntent: jest.fn(async () => ({
        intent: opts.intent,
        confidence: 'high',
        score: 90,
        wantsHuman: false,
        sensitive: false,
      })),
      runAgent: jest.fn(async () => ({ text: opts.reply })),
    } as any;
    const inbox = { sendMessage: jest.fn(async () => ({})) } as any;
    const gateway = { emitToCompany: jest.fn() } as any;
    const companyStatus = { isActive: jest.fn(async () => true) } as any;
    const featureService = {
      complianceGuardEnabled: jest.fn(async () => false),
      escalationSignalsEnabled: jest.fn(async () => false),
      conversationStateMachineEnabled: jest.fn(async () => false),
      responseConfidenceEnabled: jest.fn(async () => opts.enabled),
      engagementModeFor: jest.fn(async () => 'off'),
    } as any;
    const events = { append: jest.fn(async () => undefined) } as any;
    const workItems = { handoff: jest.fn(async () => undefined) } as any;
    const killSwitches = {
      resolveAll: jest.fn(async () => ({
        auto_reply: true, auto_order: true, sales_specialist: true,
        order_specialist: true, logistics_specialist: true,
        resolution_specialist: true, general_specialist: true,
      })),
    } as any;
    const noop = {} as any;

    const svc = new AiAgentService(
      prisma, noop, ai, noop, noop, inbox, gateway, noop, companyStatus, noop,
      noop, noop, workItems, featureService, new ComplianceGuardService(),
      events, killSwitches, new FrustrationDetectorService(),
      new FraudDetectorService(), new ToolValidatorService(),
      new ImageRouterService(), { record: jest.fn(async () => undefined) } as any,
      { apply: jest.fn(async () => undefined) } as any,
      new ConversationStateMachine(), new ResponseConfidenceService(),
      { collect: jest.fn(async () => ({})) } as any,
    );
    return { svc, prisma, ai, inbox, events };
  }

  it('low-confidence ungrounded commerce reply → handoff, not sent', async () => {
    const { svc, prisma, inbox, events } = makeAgent({
      reply: 'It costs 3500 rupees.', // number, no search_products → UNGROUNDED_PRICE
      intent: 'sales',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response.confidence',
        payload: expect.objectContaining({ decision: 'handoff' }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending', ai_autoreply: false }),
      }),
    );
  });

  it('confident reply → sent', async () => {
    const { svc, inbox, events } = makeAgent({
      reply: 'Hello! How can I help you today.',
      intent: 'general',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId, JOB.conversationId,
      expect.objectContaining({ content: 'Hello! How can I help you today.' }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response.confidence',
        payload: expect.objectContaining({ decision: 'send' }),
      }),
    );
  });

  it('flag OFF → reply sent without scoring', async () => {
    const { svc, inbox, events } = makeAgent({
      reply: 'It costs 3500 rupees.',
      intent: 'sales',
      enabled: false,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'response.confidence' }),
    );
  });
});
