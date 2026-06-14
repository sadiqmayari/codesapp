import { Module } from '@nestjs/common';
import { WorkItemService } from './work-item.service';
import { RouterService } from './router.service';

/**
 * Engagement engine (conversation/AI redesign). Phase 1 provides the work-item
 * lifecycle authority + the FSMs; Phase 2 adds the deterministic RouterService
 * (shadow message→work-item tagging behind the engagement flag). Later phases
 * add scoped specialists and commands. EventStoreService comes from the @Global
 * CommonModule.
 */
@Module({
  providers: [WorkItemService, RouterService],
  exports: [WorkItemService, RouterService],
})
export class EngagementModule {}
