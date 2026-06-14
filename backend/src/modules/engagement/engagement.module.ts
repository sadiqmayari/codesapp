import { Module } from '@nestjs/common';
import { WorkItemService } from './work-item.service';

/**
 * Engagement engine (conversation/AI redesign). Phase 1 provides the work-item
 * lifecycle authority + the FSMs; later phases add the router, scoped specialists
 * and commands. EventStoreService comes from the @Global CommonModule.
 */
@Module({
  providers: [WorkItemService],
  exports: [WorkItemService],
})
export class EngagementModule {}
