'use client';

import { useParams } from 'next/navigation';
import { PrApplyForm } from '@/components/pr/pr-apply-form';

export default function PrApplyTokenPage() {
  const { token } = useParams<{ token: string }>();
  return <PrApplyForm apiPath={`/api/public/pr/${token}`} />;
}
