import { ForbiddenException } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import {
  ComplianceGuardService,
  COMPLIANCE_HIGH_RESPONSE,
  COMPLIANCE_MEDIUM_RESPONSE,
} from '../../../common/services/compliance-guard.service';
import { FrustrationDetectorService } from '../../../common/services/frustration-detector.service';
import { FraudDetectorService } from '../../../common/services/fraud-detector.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';

/**
 * Integration tests for the Compliance Guard wiring inside AiAgentService.process().
 * Proves the contract the spec requires:
 *   - MEDIUM/HIGH → deterministic response, NO triage, NO LLM, event logged;
 *   - HIGH additionally → human handoff;
 *   - MEDIUM → no handoff;
 *   - flag OFF → existing pipeline runs (triage IS reached).
 * Everything but the real ComplianceGuardService is mocked, so no LLM/DB runs.
 */
describe('AiAgentService — compliance guard integration', () => {
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

  function makeAgent(opts: {
    customerQuery: string;
    guardEnabled: boolean;
  }) {
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
      // Flag-off path reaches triage; throw Forbidden so process() returns cleanly.
      classifyIntent: jest.fn(async () => {
        throw new ForbiddenException('AI off');
      }),
    } as any;
    const inbox = { sendMessage: jest.fn(async () => ({})) } as any;
    const gateway = { emitToCompany: jest.fn() } as any;
    const companyStatus = { isActive: jest.fn(async () => true) } as any;
    const featureService = {
      complianceGuardEnabled: jest.fn(async () => opts.guardEnabled),
      escalationSignalsEnabled: jest.fn(async () => false),
    } as any;
    const events = { append: jest.fn(async () => undefined) } as any;
    const workItems = { handoff: jest.fn(async () => undefined) } as any;
    // Kill switches: all enabled (existing behavior) for the compliance tests.
    const killSwitches = {
      resolveAll: jest.fn(async () => ({
        auto_reply: true,
        auto_order: true,
        sales_specialist: true,
        order_specialist: true,
        logistics_specialist: true,
        resolution_specialist: true,
        general_specialist: true,
      })),
    } as any;
    const noop = {} as any;

    const svc = new AiAgentService(
      prisma, // prisma
      noop, // jobQueue
      ai, // ai
      noop, // rag
      noop, // shopify
      inbox, // inbox
      gateway, // gateway
      noop, // tickets
      companyStatus, // companyStatus
      noop, // platformSetting
      noop, // router
      noop, // toldLedger
      workItems, // workItems
      featureService, // featureService
      new ComplianceGuardService(), // compliance (real)
      events, // events
      killSwitches, // killSwitches
      new FrustrationDetectorService(), // frustration
      new FraudDetectorService(), // fraud
      new ToolValidatorService(), // toolValidator
    );
    return { svc, prisma, ai, inbox, events };
  }

  it('HIGH → deterministic handoff response, no triage, event logged', async () => {
    const { svc, prisma, ai, inbox, events } = makeAgent({
      customerQuery: 'I am pregnant, can I take this?',
      guardEnabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId,
      JOB.conversationId,
      expect.objectContaining({ content: COMPLIANCE_HIGH_RESPONSE }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled(); // NO LLM
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'compliance.guard_triggered',
        payload: expect.objectContaining({ riskLevel: 'HIGH', action: 'HANDOFF' }),
      }),
    );
    // Handoff = conversation moved to pending + ai_autoreply false.
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending', ai_autoreply: false }),
      }),
    );
  });

  it('MEDIUM → safe response, no triage, NO handoff', async () => {
    const { svc, prisma, ai, inbox, events } = makeAgent({
      customerQuery: 'I have diabetes, can I use this?',
      guardEnabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId,
      JOB.conversationId,
      expect.objectContaining({ content: COMPLIANCE_MEDIUM_RESPONSE }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled(); // NO LLM
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ riskLevel: 'MEDIUM', action: 'SAFE_RESPONSE' }),
      }),
    );
    // No handoff → no pending/ai_autoreply write.
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('flag OFF → guard is skipped and the existing pipeline runs (triage reached)', async () => {
    const { svc, ai, inbox, events } = makeAgent({
      customerQuery: 'I am pregnant', // would be HIGH if the guard were on
      guardEnabled: false,
    });

    await (svc as any).process(JOB);

    expect(events.append).not.toHaveBeenCalled();
    expect(inbox.sendMessage).not.toHaveBeenCalled();
    expect(ai.classifyIntent).toHaveBeenCalled(); // existing flow proceeds
  });
});
