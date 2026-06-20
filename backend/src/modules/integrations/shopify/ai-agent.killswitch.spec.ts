import { AiAgentService } from './ai-agent.service';
import { ComplianceGuardService } from '../../../common/services/compliance-guard.service';
import { FrustrationDetectorService } from '../../../common/services/frustration-detector.service';
import { FraudDetectorService } from '../../../common/services/fraud-detector.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';
import { ImageRouterService } from '../../../common/services/image-router.service';

/**
 * Integration tests for the Global Kill Switches wiring inside
 * AiAgentService.process() (#increment 3):
 *   - AUTO_REPLY off → the AI takes no action (master brake), no triage/LLM;
 *   - a disabled specialist → deterministic human handoff + audit event, the
 *     specialist tool loop (ai.runAgent) never runs.
 * All collaborators are mocked; the real ComplianceGuardService is used but the
 * compliance flag is OFF so it does not interfere.
 */
describe('AiAgentService — kill-switch integration', () => {
  const JOB = { companyId: 7, conversationId: 100, messageId: 5 };

  const ctx = {
    transcript: 'Customer: hi',
    contactLine: 'Customer: Test',
    contactName: 'Test',
    contactPhone: '+923171234567',
    hasCustomerText: true,
    customerQuery: 'hi',
    companyName: 'Sois',
    brandTone: null,
    langRule: 'English',
    tier: 'fast',
    autoOrderEnabled: false,
    defaultCountryCode: 'PK',
  };

  function makeAgent(snapshot: Record<string, boolean>, triageIntent = 'sales') {
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
        findMany: jest.fn(async () => []), // anti-repeat lookup → no prior replies
      },
      supportTicket: { findFirst: jest.fn(async () => null) },
      conversationLabel: { upsert: jest.fn(async () => ({})) },
    } as any;

    const ai = {
      buildAgentContext: jest.fn(async () => ({ ...ctx })),
      classifyIntent: jest.fn(async () => ({
        intent: triageIntent,
        confidence: 'high',
        score: 90,
        wantsHuman: false,
        sensitive: false,
      })),
      runAgent: jest.fn(async () => ({ text: 'should not run' })),
    } as any;
    const inbox = { sendMessage: jest.fn(async () => ({})) } as any;
    const gateway = { emitToCompany: jest.fn() } as any;
    const companyStatus = { isActive: jest.fn(async () => true) } as any;
    const featureService = {
      complianceGuardEnabled: jest.fn(async () => false),
      escalationSignalsEnabled: jest.fn(async () => false),
      engagementModeFor: jest.fn(async () => 'off'),
    } as any;
    const events = { append: jest.fn(async () => undefined) } as any;
    const workItems = { handoff: jest.fn(async () => undefined) } as any;
    const killSwitches = { resolveAll: jest.fn(async () => snapshot) } as any;
    const noop = {} as any;

    const svc = new AiAgentService(
      prisma, noop, ai, noop, noop, inbox, gateway, noop, companyStatus, noop,
      noop, noop, workItems, featureService, new ComplianceGuardService(),
      events, killSwitches, new FrustrationDetectorService(),
      new FraudDetectorService(), new ToolValidatorService(),
      new ImageRouterService(),
    );
    return { svc, prisma, ai, inbox, events };
  }

  const allOn = {
    auto_reply: true, auto_order: true, sales_specialist: true,
    order_specialist: true, logistics_specialist: true,
    resolution_specialist: true, general_specialist: true,
  };

  it('AUTO_REPLY off → no AI action at all (no triage, no reply)', async () => {
    const { svc, ai, inbox, events } = makeAgent({ ...allOn, auto_reply: false });

    await (svc as any).process(JOB);

    expect(ai.classifyIntent).not.toHaveBeenCalled();
    expect(ai.runAgent).not.toHaveBeenCalled();
    expect(inbox.sendMessage).not.toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalled();
  });

  it('disabled specialist → handoff + audit event, specialist loop never runs', async () => {
    const { svc, prisma, ai, events } = makeAgent(
      { ...allOn, sales_specialist: false },
      'sales',
    );

    await (svc as any).process(JOB);

    expect(ai.classifyIntent).toHaveBeenCalled(); // triage runs (it's not the master brake)
    expect(ai.runAgent).not.toHaveBeenCalled(); // but the specialist never executes
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'killswitch.specialist_disabled',
        payload: expect.objectContaining({ intent: 'sales' }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending', ai_autoreply: false }),
      }),
    );
  });

  it('all switches on → pipeline reaches the specialist (no brake)', async () => {
    const { svc, ai } = makeAgent({ ...allOn }, 'sales');

    await (svc as any).process(JOB);

    expect(ai.runAgent).toHaveBeenCalled(); // sales specialist ran
  });
});
