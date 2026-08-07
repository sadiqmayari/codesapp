import type { Metadata } from 'next';

// Public but not indexed — these per-order pages are token-gated and personal.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: 'Order tracking',
};

export default function TrackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
