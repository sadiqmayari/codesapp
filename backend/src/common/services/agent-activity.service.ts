import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type AgentAction =
  | 'order_confirmed'
  | 'address_corrected'
  | 'order_cancelled'
  | 'contact_logged';

/**
 * Records per-agent actions the app doesn't otherwise attribute to a user, into
 * the append-only `agent_activity` log that powers the owner/admin Agent
 * Performance report. Best-effort / never-throws: a logging failure must never
 * break the underlying action (a confirm, an address edit, a cancel).
 */
@Injectable()
export class AgentActivityService {
  private readonly logger = new Logger(AgentActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    companyId: number,
    userId: number | null | undefined,
    action: AgentAction,
    opts: { orderGid?: string | null; orderName?: string | null; contactId?: number | null } = {},
  ): Promise<void> {
    // No user = an automatic/system action (webhook auto-confirm, cron) — not an
    // agent action, so it never appears in the report.
    if (!userId) return;
    try {
      await this.prisma.agentActivity.create({
        data: {
          company_id: companyId,
          user_id: userId,
          action,
          order_gid: opts.orderGid ?? null,
          order_name: opts.orderName ?? null,
          contact_id: opts.contactId ?? null,
        },
      });
    } catch (err) {
      this.logger.debug(
        `agent_activity record failed (company ${companyId}, user ${userId}, ${action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
