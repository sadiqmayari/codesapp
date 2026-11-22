'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { itemForVariant } from '@/lib/inventory';
import { SkeletonRows } from '@/components/ui/skeleton';

/**
 * Legacy deep link (/inventory/<variant id>, from the v1 board and old
 * bookmarks). Inventory v2 is item-based: resolve the variant to its master
 * item and open it in the catalogue's item sheet.
 */
export default function LegacyInventoryVariantRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    const id = Number(params?.id);
    if (!Number.isInteger(id)) {
      router.replace('/inventory');
      return;
    }
    itemForVariant(id)
      .then((r) => router.replace(`/inventory?item=${r.itemId}`))
      .catch(() => router.replace('/inventory'));
    // router omitted from deps (Next 14 wrapper identity is unstable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <SkeletonRows rows={4} />
    </div>
  );
}
