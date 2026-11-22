'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import type { TeamRole } from '@/lib/crm-types';
import { SettingsSkeleton } from '@/components/settings/shared';
import { canAccess, defaultSectionFor, findSection, type SettingsSectionId } from '@/components/settings/nav';
import { ProfileSection, SecuritySection, NotificationsSection } from '@/components/settings/account';
import { GeneralSection } from '@/components/settings/general';
import { TeamSection } from '@/components/settings/team';
import { TrackingSection } from '@/components/settings/tracking';
import { CompetitionSection } from '@/components/settings/competition';
import { WhatsAppSection } from '@/components/settings/whatsapp';
import { StoresSection } from '@/components/settings/stores';
import {
  ConfirmationSection,
  AbandonedSection,
  DeliverySection,
} from '@/components/settings/order-automation';
import { CouriersSection } from '@/components/settings/couriers';
import { AiSection } from '@/components/settings/ai';
import {
  AiProfileSection,
  AiSkillsSection,
  AiHandoffSection,
  AiPlaygroundSection,
  AiPerformanceSection,
} from '@/components/settings/ai-agent';
import { KnowledgeSection } from '@/components/settings/knowledge';
import { IntegrationsSection } from '@/components/settings/integrations';
import { InventorySection } from '@/components/settings/inventory';

/**
 * `/settings/<section>` — one page per section (deep-linkable, survives a
 * refresh). Access is checked against `components/settings/nav.ts`; a section
 * the role can't open redirects to the role's default.
 */
export default function SettingsSectionPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ section: string }>();
  const id = params?.section ?? '';
  const item = findSection(id);
  const allowed = !!item && !!user && canAccess(item, user.role);

  useEffect(() => {
    if (loading || !user) return;
    if (!allowed) router.replace(`/settings/${defaultSectionFor(user.role)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router wrapper identity is unstable (CLAUDE.md)
  }, [loading, user, allowed]);

  if (loading || !user || !allowed) return <SettingsSkeleton />;

  switch (id as SettingsSectionId) {
    case 'profile':
      return <ProfileSection />;
    case 'security':
      return <SecuritySection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'general':
      return <GeneralSection />;
    case 'team':
      return <TeamSection actorRole={user.role as TeamRole} />;
    case 'tracking':
      return <TrackingSection />;
    case 'competition':
      return <CompetitionSection />;
    case 'whatsapp':
      return <WhatsAppSection />;
    case 'stores':
      return <StoresSection />;
    case 'confirmation':
      return <ConfirmationSection />;
    case 'abandoned':
      return <AbandonedSection />;
    case 'delivery':
      return <DeliverySection />;
    case 'couriers':
      return <CouriersSection />;
    case 'ai':
      return <AiSection />;
    case 'ai-profile':
      return <AiProfileSection />;
    case 'ai-skills':
      return <AiSkillsSection />;
    case 'ai-handoff':
      return <AiHandoffSection />;
    case 'ai-playground':
      return <AiPlaygroundSection />;
    case 'ai-performance':
      return <AiPerformanceSection />;
    case 'knowledge':
      return <KnowledgeSection />;
    case 'inventory':
      return <InventorySection />;
    case 'integrations':
      return <IntegrationsSection />;
    default:
      return <SettingsSkeleton />;
  }
}
