'use client';

import { useParams } from 'next/navigation';
import { PrApplyForm } from '@/components/pr/pr-apply-form';

export default function PrApplySlugPage() {
  const { tenant, campaign } = useParams<{ tenant: string; campaign: string }>();
  return (
    <PrApplyForm
      apiPath={`/api/public/pr/s/${encodeURIComponent(tenant)}/${encodeURIComponent(campaign)}`}
    />
  );
}
