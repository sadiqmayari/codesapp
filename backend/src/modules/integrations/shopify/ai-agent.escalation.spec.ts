import { ForbiddenException } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import { ComplianceGuardService } from '../../../common/services/compliance-guard.service';
import {
  FrustrationDetectorService,
  FRUSTRATION_HANDOFF_ACK,
} from '../../../common/services/frustration-detector.service';
import {
  FraudDetectorService,
  FRAUD_HANDOFF_ACK,
} from '../../../common/services/fraud-detector.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';
import { ImageRouterService } from '../../../common/services/image-router.service';
import { ConversationStateMachine } from '../../../common/services/conversation-state-machine';
import { ResponseConfidenceService } from '../../../common/services/response-confidence.service';

/**
 * Integration tests for the escalation-signals wiring in process() (#increment 4):
 *   - frustration over threshold → ack + handoff + frustration.detected, no LLM;
 *   - fraud over threshold → neutral ack + handoff + fraud.risk_flagged, no LLM;
 *   - flag OFF → existing pipeline runs (triage reached).
 * Real detectors are used; everything else is mocked.
 */
describe('AiAgentService — escalation-signals integration', () => {
  const JOB = { companyId: 7, conversationId: 100, messageId: 5 };

  function buildCtx(customerQuery: string) {
    return {
      transcript: `Customer: ${customerQuery}`,
      contactLine: 'Customer: Test',
      contactName: 'Test',
      contactPhone: '+923171234567',
      hasCustomerText: true,
      customerQuery,
      companyName: 'Sois',
      brandTone: null,
      langRule: 'English',
      tier: 'fast',
      autoOrderEnabled: false,
      defaultCountryCode: 'PK',
    };
  }

  function makeAgent(opts: { customerQuery: string; enabled: boolean }) {
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
      message: { findFirst: jest.fn(async () => null) },
      supportTicket: { findFirst: jest.fn(async () => null) },
      conversationLabel: { upsert: jest.fn(async () => ({})) },
    } as any;

    const ai = {
      buildAgentContext: jest.fn(async () => buildCtx(opts.customerQuery)),
      classifyIntent: jest.fn(async () => {
        throw new ForbiddenException('AI off'); // flag-off path returns cleanly
      }),
      runAgent: jest.fn(async () => ({ text: 'x' })),
    } as any;
    const inbox = { sendMessage: jest.fn(async () => ({})) } as any;
    const gateway = { emitToCompany: jest.fn() } as any;
    const companyStatus = { isActive: jest.fn(async () => true) } as any;
    const featureService = {
      complianceGuardEnabled: jest.fn(async () => false),
      escalationSignalsEnabled: jest.fn(async () => opts.enabled),
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
      prisma, noop, ai, noop, noop, inbox, gateway, noop, companyStatus,
      noop /* platformSetting → thresholdFor falls back to defaults */,
      noop, noop, workItems, featureService, new ComplianceGuardService(),
      events, killSwitches, new FrustrationDetectorService(),
      new FraudDetectorService(), new ToolValidatorService(),
      new ImageRouterService(),
      { record: jest.fn(async () => undefined) } as any,
      { apply: jest.fn(async () => undefined) } as any,
      new ConversationStateMachine(),
      new ResponseConfidenceService(),
      { collect: jest.fn(async () => ({})) } as any, // fraudCollector
    );
    return { svc, prisma, ai, inbox, events };
  }

  it('frustration over threshold → ack + handoff, no triage', async () => {
    const { svc, prisma, ai, inbox, events } = makeAgent({
      customerQuery: 'I already told you my address',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId, JOB.conversationId,
      expect.objectContaining({ content: FRUSTRATION_HANDOFF_ACK }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frustration.detected' }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending', ai_autoreply: false }),
      }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled();
  });

  it('fraud over threshold → neutral ack + handoff, no triage', async () => {
    const { svc, ai, inbox, events } = makeAgent({
      customerQuery: 'please send the money to my personal account instead',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId, JOB.conversationId,
      expect.objectContaining({ content: FRAUD_HANDOFF_ACK }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fraud.risk_flagged',
        payload: expect.objectContaining({ riskFactors: ['PAYMENT_REDIRECTION'] }),
      }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled();
  });

  it('flag OFF → escalation skipped, pipeline reaches triage', async () => {
    const { svc, ai, inbox, events } = makeAgent({
      customerQuery: 'I already told you my address',
      enabled: false,
    });

    await (svc as any).process(JOB);

    expect(events.append).not.toHaveBeenCalled();
    expect(inbox.sendMessage).not.toHaveBeenCalled();
    expect(ai.classifyIntent).toHaveBeenCalled();
  });
});
