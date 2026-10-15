import type { Metadata } from 'next';

// Public but not indexed — token-gated influencer submission forms.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: 'Influencer application',
};

export default function PrApplyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
