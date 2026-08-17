'use client';

import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { OrderDetailContent } from '@/components/orders/order-detail-view';

/**
 * Full-page order detail — the deep-linkable/shareable form of the same panel
 * used in the drawer. Keyed by the Shopify order number (e.g. /orders/34919).
 */
export default function OrderDetailPage() {
  const params = useParams<{ orderNo: string }>();
  const router = useRouter();
  const orderNo = String(params?.orderNo ?? '').replace(/[^0-9]/g, '');

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-5">
      <button
        onClick={() => router.back()}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={16} /> Back
      </button>
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-slate-50 shadow-sm">
        <OrderDetailContent orderKey={{ number: orderNo }} />
      </div>
    </div>
  );
}
