import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { InboxModule } from '../inbox/inbox.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { AiAgentService as LegacyAgentService } from '../integrations/shopify/ai-agent.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentSkills } from './skills';
import { AgentHandoffService } from './handoff.service';
import { AgentBookingsService } from './bookings.service';
import { AgentInsightsService } from './agent-insights.service';
import { AgentMaintenanceService } from './agent-maintenance.service';
import { AiAgentController } from './ai-agent.controller';
import { SuperAdminAiController } from './super-admin-ai.controller';
import { SuperAdminAiService } from './super-admin-ai.service';

/**
 * AI Agent v2 — the ONE conversational brain (runtime + skills + handoff +
 * bookings + insights). A LEAF module: it imports AiModule, InboxModule,
 * ShopifyModule (commerce resolver) and TicketsModule; nothing imports it, so
 * no cycle. The legacy v1 brain (`AiAgentService`) is provided here too while
 * tenants move off engine 'v1'/'shadow'; it is deleted at the cutover.
 */
@Module({
  imports: [AuthModule, AiModule, InboxModule, TicketsModule, WebhooksModule, ShopifyModule],
  controllers: [AiAgentController, SuperAdminAiController],
  providers: [
    AgentRuntimeService,
    AgentSkills,
    AgentHandoffService,
    AgentBookingsService,
    AgentInsightsService,
    AgentMaintenanceService,
    SuperAdminAiService,
    LegacyAgentService,
  ],
  exports: [AgentRuntimeService],
})
export class AiAgentModule {}
