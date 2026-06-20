import { ForbiddenException } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import { ComplianceGuardService } from '../../../common/services/compliance-guard.service';
import { FrustrationDetectorService } from '../../../common/services/frustration-detector.service';
import { FraudDetectorService } from '../../../common/services/fraud-detector.service';
import { ToolValidatorService } from '../../../common/services/tool-validator.service';
import {
  ImageRouterService,
  IMAGE_PAYMENT_SLIP_ACK,
  IMAGE_PRESCRIPTION_RESPONSE,
} from '../../../common/services/image-router.service';

/**
 * Integration tests for the multimodal image-routing wiring in process()
 * (#increment 7): PAYMENT_SLIP / PRESCRIPTION images short-circuit to a fixed
 * response + handoff with NO LLM; PRODUCT_IMAGE flows on to triage; flag OFF
 * skips routing entirely.
 */
describe('AiAgentService — multimodal image routing', () => {
  const JOB = { companyId: 7, conversationId: 100, messageId: 5 };

  function makeAgent(opts: { caption: string; enabled: boolean }) {
    const ctx = {
      transcript: `Customer: ${opts.caption}`,
      contactLine: 'Customer: Test',
      contactName: 'Test',
      contactPhone: '+923171234567',
      hasCustomerText: true,
      customerQuery: opts.caption,
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
      // Latest inbound is an IMAGE carrying the caption text.
      message: {
        findFirst: jest.fn(async () => ({
          message_type: 'image',
          timestamp: new Date(),
          content: opts.caption,
          transcription: null,
        })),
      },
      supportTicket: { findFirst: jest.fn(async () => null) },
      conversationLabel: { upsert: jest.fn(async () => ({})) },
    } as any;

    const ai = {
      buildAgentContext: jest.fn(async () => ({ ...ctx })),
      classifyIntent: jest.fn(async () => {
        throw new ForbiddenException('AI off');
      }),
      runAgent: jest.fn(async () => ({ text: 'x' })),
    } as any;
    const inbox = { sendMessage: jest.fn(async () => ({})) } as any;
    const gateway = { emitToCompany: jest.fn() } as any;
    const companyStatus = { isActive: jest.fn(async () => true) } as any;
    const featureService = {
      complianceGuardEnabled: jest.fn(async () => false),
      escalationSignalsEnabled: jest.fn(async () => false),
      multimodalRoutingEnabled: jest.fn(async () => opts.enabled),
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
      new ImageRouterService(),
    );
    return { svc, prisma, ai, inbox, events };
  }

  it('PAYMENT_SLIP image → fixed ack + handoff, no triage', async () => {
    const { svc, prisma, ai, inbox, events } = makeAgent({
      caption: 'here is my payment slip',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId, JOB.conversationId,
      expect.objectContaining({ content: IMAGE_PAYMENT_SLIP_ACK }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image.routed',
        payload: expect.objectContaining({ imageType: 'PAYMENT_SLIP' }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending', ai_autoreply: false }),
      }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled();
  });

  it('PRESCRIPTION image → fixed safe response + handoff, no triage', async () => {
    const { svc, ai, inbox, events } = makeAgent({
      caption: 'sharing my doctor prescription',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(inbox.sendMessage).toHaveBeenCalledWith(
      JOB.companyId, JOB.conversationId,
      expect.objectContaining({ content: IMAGE_PRESCRIPTION_RESPONSE }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ imageType: 'PRESCRIPTION' }),
      }),
    );
    expect(ai.classifyIntent).not.toHaveBeenCalled();
  });

  it('PRODUCT_IMAGE → records routing hint and continues to triage', async () => {
    const { svc, ai, inbox, events } = makeAgent({
      caption: 'do you have this one in stock',
      enabled: true,
    });

    await (svc as any).process(JOB);

    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ imageType: 'PRODUCT_IMAGE' }),
      }),
    );
    expect(inbox.sendMessage).not.toHaveBeenCalled(); // no short-circuit reply
    expect(ai.classifyIntent).toHaveBeenCalled(); // pipeline proceeds
  });

  it('flag OFF → image routing skipped, pipeline reaches triage', async () => {
    const { svc, ai, events } = makeAgent({
      caption: 'here is my payment slip',
      enabled: false,
    });

    await (svc as any).process(JOB);

    expect(events.append).not.toHaveBeenCalled();
    expect(ai.classifyIntent).toHaveBeenCalled();
  });
});
