import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import './globals.css';
import './dark-overrides.css';
import { AuthProvider } from '@/context/auth-context';
import { ToastProvider } from '@/components/toast';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

const fontSans = Manrope({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

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
    <html lang="en" className={fontSans.variable} suppressHydrationWarning>
      <head>
        {/* Applies the saved light/dark theme before paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
