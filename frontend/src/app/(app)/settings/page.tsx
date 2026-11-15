'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { SettingsSkeleton } from '@/components/settings/shared';
import {
  LEGACY_TAB_MAP,
  canAccess,
  defaultSectionFor,
  findSection,
} from '@/components/settings/nav';

/**
 * `/settings` → the role's first section. Old `/settings?tab=…` links keep
 * working (mapped through LEGACY_TAB_MAP).
 */
export default function SettingsIndex() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsRedirect />
    </Suspense>
  );
}

function SettingsRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get('tab');

  useEffect(() => {
    if (loading || !user) return;
    const legacy = tab ? LEGACY_TAB_MAP[tab] : undefined;
    const item = legacy ? findSection(legacy) : undefined;
    const target =
      item && canAccess(item, user.role) ? item.id : defaultSectionFor(user.role);
    router.replace(`/settings/${target}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router wrapper identity is unstable (CLAUDE.md)
  }, [loading, user, tab]);

  return <SettingsSkeleton />;
}
