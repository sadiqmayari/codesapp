'use client';

import { useEffect, useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  createLocation,
  getInventorySettings,
  getLocations,
  saveInventorySettings,
  updateLocation,
  updateLocationLink,
  type InventoryLocation,
  type InventorySettings,
} from '@/lib/inventory';
import { Rows, SettingRow, SettingsCard, SettingsPage, SettingsSkeleton } from './shared';

const inputCls =
  'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20';

/** Settings → Inventory: locations (and how each store maps onto them) + stock rules. */
export function InventorySection() {
  const toast = useToast();
  const [locs, setLocs] = useState<InventoryLocation[] | null>(null);
  const [s, setS] = useState<InventorySettings | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    getLocations().then(setLocs).catch(() => setLocs([]));
    getInventorySettings().then(setS).catch(() => undefined);
  }, []);

  const save = async (patch: Partial<InventorySettings>) => {
    if (!s) return;
    const prev = s;
    setS({ ...s, ...patch });
    try {
      setS(await saveInventorySettings(patch));
    } catch (e) {
      setS(prev);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    }
  };

  const wrap = async (p: Promise<InventoryLocation[]>, ok?: string) => {
    try {
      setLocs(await p);
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    }
  };

  if (!locs || !s) return <SettingsSkeleton cards={2} />;

  const toggle = (key: keyof InventorySettings, title: string, description: string) => (
    <SettingRow title={title} description={description}>
      <Switch checked={!!s[key]} onChange={(v) => void save({ [key]: v } as Partial<InventorySettings>)} label={title} />
    </SettingRow>
  );
  const number = (key: keyof InventorySettings, title: string, description: string, unit: string) => (
    <SettingRow title={title} description={description}>
      <span className="flex items-center gap-2">
        <input
          aria-label={title}
          className={`${inputCls} w-20 text-right`}
          inputMode="numeric"
          defaultValue={String(s[key])}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n !== s[key]) void save({ [key]: n } as Partial<InventorySettings>);
          }}
        />
        <span className="text-sm text-muted">{unit}</span>
      </span>
    </SettingRow>
  );

  return (
    <SettingsPage title="Inventory" description="Where your stock lives, how stores share it, and the rules for selling and reordering.">
      <SettingsCard
        title="Locations"
        description="Each store location is mapped onto one of your locations. Two stores fed from the same warehouse share its stock."
      >
        <div className="flex flex-col gap-3">
          {locs.map((l) => (
            <div key={l.id} className="flex flex-col gap-2 rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  <input
                    aria-label="Location name"
                    className={`${inputCls} w-56 font-semibold`}
                    defaultValue={l.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && void wrap(updateLocation(l.id, { name: e.target.value }))}
                  />
                  {l.isDefault && <Badge tone="brand">Default</Badge>}
                  {!l.isActive && <Badge tone="neutral">Inactive</Badge>}
                </span>
                <span className="flex gap-2">
                  {!l.isDefault && (
                    <Button size="sm" variant="ghost" onClick={() => void wrap(updateLocation(l.id, { isDefault: true }), 'Default location changed')}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void wrap(updateLocation(l.id, { isActive: !l.isActive }))}>
                    {l.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </span>
              </div>
              {l.links.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {l.links.map((k) => (
                    <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 text-sm">
                      <span>
                        <b>{k.storeLabel}</b> · {k.externalName ?? 'store stock'}
                      </span>
                      <span className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`lk-${k.id}`}>Feeds location</label>
                        <select
                          id={`lk-${k.id}`}
                          className={`${inputCls} h-8`}
                          value={l.id}
                          onChange={(e) => void wrap(updateLocationLink(k.id, { locationId: Number(e.target.value) }), 'Mapping saved — re-reading the store')}
                        >
                          {locs.map((o) => (
                            <option key={o.id} value={o.id}>{o.name}</option>
                          ))}
                        </select>
                        <Switch
                          size="sm"
                          checked={k.syncEnabled}
                          onChange={(v) => void wrap(updateLocationLink(k.id, { syncEnabled: v }))}
                          label={`Sync ${k.storeLabel} ${k.externalName ?? ''}`}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">No store location feeds this one yet.</p>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <input
              aria-label="New location name"
              className={`${inputCls} flex-1`}
              placeholder="New location, e.g. Karachi warehouse"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={!newName.trim()}
              onClick={() => {
                void wrap(createLocation({ name: newName.trim() }), 'Location added');
                setNewName('');
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add
            </Button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Selling">
        <Rows>
          {toggle('allowBackorder', 'Allow selling when out of stock', 'Agents and the AI agent may still order an item at 0. Per-item override in the item’s details.')}
          {toggle('warnOverAvailable', 'Warn when an order asks for more than is available', 'Shown in the create-order window.')}
          {toggle('restockReturns', 'Restock returns when they arrive', 'A scanned-in return parcel puts its items back in stock (once). Shopify is told not to restock again.')}
        </Rows>
      </SettingsCard>

      <SettingsCard title="Alerts">
        <Rows>
          {toggle('lowStockAlerts', 'Low-stock alerts', 'Notify owners and admins when an item drops to its reorder point.')}
          {toggle('dailyDigest', 'Daily email digest', 'One email each morning with every low and out-of-stock item.')}
          {toggle('adsOutOfStockAlert', 'Out of stock while ads spend', 'Alert when an ad that spent today sends people to an item with no stock.')}
          {toggle('backInStockOffer', 'Back-in-stock messages', 'When an item comes back, offer to message everyone on its waitlist.')}
        </Rows>
      </SettingsCard>

      <SettingsCard title="Reordering and checks">
        <Rows>
          {number('targetCoverDays', 'Target stock cover', 'Reorder suggestions aim to hold this many days of sales after the supplier delivers.', 'days')}
          {number('defaultLeadTimeDays', 'Default supplier lead time', 'Used when an item and its supplier have none.', 'days')}
          {number('countCadenceDays', 'Count best sellers every', 'Your top items get a stock-count reminder at this interval.', 'days')}
          {number('reconcileMinutes', 'Check stores for missed changes every', 'CodesApp compares each store with its stock and fixes anything a webhook missed.', 'minutes')}
        </Rows>
      </SettingsCard>
    </SettingsPage>
  );
}
