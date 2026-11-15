'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Webhook } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { BrandMark } from '@/components/icons/brand-logo';
import type { Accounts } from '@/lib/growth';
import type { DriveStatus } from '@/lib/content';
import { SettingsPage } from './shared';

interface Tile {
  key: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  status: { tone: BadgeTone; text: string } | null;
  where: string;
  href: string;
  cta: string;
  muted?: boolean;
}

/**
 * Settings → Integrations: the outside services that are managed on their own
 * pages (WhatsApp, stores and couriers have dedicated Settings sections, so
 * they're deliberately NOT repeated here). Status is best-effort — a tile
 * without permission/feature just shows no badge.
 */
export function IntegrationsSection() {
  const [ads, setAds] = useState<Accounts | null | undefined>(undefined);
  const [drive, setDrive] = useState<DriveStatus | null | undefined>(undefined);
  const [hooks, setHooks] = useState<boolean | null | undefined>(undefined);

  useEffect(() => {
    apiFetch<Accounts>('/growth/accounts', { noOnboardingRedirect: true })
      .then(setAds)
      .catch(() => setAds(null));
    apiFetch<DriveStatus>('/content/drive/status', { noOnboardingRedirect: true })
      .then(setDrive)
      .catch(() => setDrive(null));
    apiFetch<{ features?: { webhookEnabled?: boolean } }>('/billing/subscription')
      .then((s) => setHooks(!!s?.features?.webhookEnabled))
      .catch(() => setHooks(null));
  }, []);

  const metaAccounts = ads?.accounts.filter((a) => a.platform === 'meta') ?? [];
  const otherAds = ads?.platforms.filter((p) => p.platform !== 'meta') ?? [];

  const tiles: Tile[] = [
    {
      key: 'meta',
      icon: <BrandMark brand="meta" />,
      title: 'Meta Ads',
      sub: 'Spend, ROAS and delivered-purchase events',
      status:
        ads === undefined
          ? null
          : metaAccounts.length
            ? { tone: 'success', text: `${metaAccounts.length} ad account${metaAccounts.length === 1 ? '' : 's'}` }
            : { tone: 'neutral', text: 'Not connected' },
      where: 'Growth → Connections',
      href: '/growth/connections',
      cta: metaAccounts.length ? 'Manage' : 'Connect',
    },
    {
      key: 'drive',
      icon: <BrandMark brand="gdrive" />,
      title: 'Google Drive',
      sub: 'Where Content module files are stored',
      status:
        drive === undefined || drive === null
          ? null
          : drive.connected
            ? { tone: 'success', text: drive.email ? `Connected · ${drive.email}` : 'Connected' }
            : { tone: 'neutral', text: 'Not connected' },
      where: 'Content',
      href: '/content',
      cta: drive?.connected ? 'Open' : 'Connect',
    },
    {
      key: 'webhooks',
      icon: (
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-700 text-white">
          <Webhook size={20} />
        </span>
      ),
      title: 'Outbound webhooks',
      sub: 'Send CodesApp events to your own systems',
      status: hooks === false ? { tone: 'neutral', text: 'Not in your plan' } : null,
      where: 'Webhooks',
      href: '/webhooks',
      cta: 'Open',
      muted: hooks === false,
    },
    ...(otherAds.length
      ? [
          {
            key: 'other-ads',
            icon: (
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-sunken text-sm font-extrabold text-muted">
                +{otherAds.length}
              </span>
            ),
            title: otherAds.map((p) => p.label).join(', '),
            sub: otherAds.some((p) => p.available) ? 'Ad platforms you can connect' : 'Waiting for platform approval',
            status: otherAds.some((p) => p.available)
              ? { tone: 'success' as BadgeTone, text: 'Available' }
              : { tone: 'info' as BadgeTone, text: 'Coming soon' },
            where: 'Growth → Connections',
            href: '/growth/connections',
            cta: 'Open',
            muted: !otherAds.some((p) => p.available),
          },
        ]
      : []),
  ];

  return (
    <SettingsPage
      title="Integrations"
      description="Other services CodesApp connects to. WhatsApp, stores and couriers have their own pages in Settings."
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className={
              'flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm transition hover:-translate-y-px hover:border-brand-400' +
              (t.muted ? ' opacity-75' : '')
            }
          >
            <div className="flex min-w-0 items-center gap-3">
              {t.icon}
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold text-ink">{t.title}</p>
                <p className="truncate text-xs text-muted">{t.sub}</p>
              </div>
            </div>
            <div className="min-h-[22px]">{t.status && <Badge tone={t.status.tone}>{t.status.text}</Badge>}</div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-[13px] text-muted">
              <span>{t.where}</span>
              <span className="inline-flex items-center gap-1 font-semibold text-brand-700 dark:text-brand-300">
                {t.cta} <ArrowUpRight size={14} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </SettingsPage>
  );
}
