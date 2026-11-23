'use client';

import { useEffect, useState } from 'react';
import { getTenantCouriers, type TenantCouriers } from './couriers';

const EMPTY: TenantCouriers = { bookable: [], configured: [] };

/** The tenant's connected couriers (shared, cached fetch). Empty until loaded
 *  — pickers show only couriers the tenant actually connected. */
export function useTenantCouriers(): TenantCouriers & { loaded: boolean } {
  const [state, setState] = useState<TenantCouriers | null>(null);
  useEffect(() => {
    let alive = true;
    getTenantCouriers()
      .then((r) => alive && setState(r))
      .catch(() => alive && setState(EMPTY));
    return () => {
      alive = false;
    };
  }, []);
  return { ...(state ?? EMPTY), loaded: state !== null };
}
