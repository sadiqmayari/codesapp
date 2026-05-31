import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/context/auth-context';
import { ToastProvider } from '@/components/toast';

export const metadata: Metadata = {
  title: 'CodesApp — WhatsApp CRM',
  description: 'Multi-tenant SaaS WhatsApp CRM & Automation by Codentra',
  manifest: '/manifest.webmanifest',
  applicationName: 'CodesApp',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'CodesApp',
  },
};

export const viewport: Viewport = {
  themeColor: '#16a34a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
