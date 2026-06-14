import { Module } from '@nestjs/common';
import { WorkItemService } from './work-item.service';
import { RouterService } from './router.service';
import { ToldLedgerService } from './told-ledger.service';

/**
 * Engagement engine (conversation/AI redesign). Phase 1: work-item lifecycle +
 * FSMs. Phase 2: deterministic RouterService. Phase 3: authoritative routing +
 * context scoping. Phase 4: ToldLedgerService (don't-repeat-status) + commands.
 * EventStoreService comes from the @Global CommonModule.
 */
@Module({
  providers: [WorkItemService, RouterService, ToldLedgerService],
  exports: [WorkItemService, RouterService, ToldLedgerService],
})
export class EngagementModule {}
