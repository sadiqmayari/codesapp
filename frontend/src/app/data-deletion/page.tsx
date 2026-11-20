import type { Metadata } from 'next';

// Public page (no login) — the "User data deletion → Data deletion
// instructions URL" Meta requires for App Review:
//   https://apps.codentra.pk/data-deletion
// Not under any PROTECTED_PREFIXES in middleware.ts, and outside the (app)
// group, so it renders without the auth gate. Static: no API calls.

export const metadata: Metadata = {
  title: 'Data Deletion Instructions — CodesApp',
  description:
    'How to request deletion of your data from CodesApp, the Codentra customer-engagement platform.',
};

const CONTACT = 'admin@codentra.pk';
const UPDATED = '20 November 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-sunken px-4 py-10 sm:py-16">
      <article className="mx-auto max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold text-brand-600">CodesApp by Codentra</p>
        <h1 className="mt-1 text-2xl font-bold text-ink sm:text-3xl">Data Deletion Instructions</h1>
        <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

        <p className="mt-6 text-[15px] leading-relaxed text-muted">
          CodesApp (apps.codentra.pk) is a customer-engagement platform that businesses use to
          manage conversations with their customers on WhatsApp, Messenger and Instagram. This page
          explains how to request deletion of the data CodesApp holds about you.
        </p>

        <Section title="What data we hold">
          <ul className="list-disc space-y-1 pl-5">
            <li>Account details of business users (name, email, phone, company).</li>
            <li>
              Access tokens for connected Meta accounts (WhatsApp Business, Facebook, Instagram),
              stored encrypted.
            </li>
            <li>
              Contacts, conversations, messages and media exchanged between a business and its
              customers.
            </li>
            <li>Order and delivery records a business chooses to sync into CodesApp.</li>
          </ul>
        </Section>

        <Section title="If you use CodesApp for your business">
          <p>
            Email <strong className="text-ink">{CONTACT}</strong> from the email address on your
            CodesApp account, with the subject <strong className="text-ink">“Data deletion request”</strong>.
            Tell us whether you want your whole account deleted or only specific data (for example,
            a disconnected WhatsApp number).
          </p>
          <p>
            You can also disconnect CodesApp from Meta at any time: in Facebook go to{' '}
            <strong className="text-ink">Settings &amp; privacy → Settings → Business integrations</strong>,
            select CodesApp and choose <strong className="text-ink">Remove</strong>. This revokes our
            access to your Meta assets immediately.
          </p>
        </Section>

        <Section title="If you messaged a business that uses CodesApp">
          <p>
            The business you contacted controls your conversation data. Ask that business to delete
            it, or email <strong className="text-ink">{CONTACT}</strong> with the subject{' '}
            <strong className="text-ink">“Data deletion request”</strong>, the phone number or
            account you messaged from, and the name of the business. We will verify the request and
            delete the data or pass it to that business to action.
          </p>
        </Section>

        <Section title="What happens next">
          <ul className="list-disc space-y-1 pl-5">
            <li>We confirm we received your request within 3 business days.</li>
            <li>Connected Meta access tokens are revoked as soon as the request is verified.</li>
            <li>Your data is deleted from our live systems within 30 days, and we confirm by email.</li>
            <li>Copies in encrypted backups are overwritten within a further 90 days.</li>
            <li>
              Records we must keep by law (for example, invoices) are retained only for the period
              required, then deleted.
            </li>
          </ul>
          <p>Media files in conversations are also deleted automatically 30 days after they are received.</p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this page or your data: <strong className="text-ink">{CONTACT}</strong>.
          </p>
        </Section>

        <div className="mt-10 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-5 text-sm">
          <a href="https://codentra.pk/privacy" className="text-brand-600 hover:underline">
            Privacy Policy
          </a>
          <a href="https://codentra.pk/terms" className="text-brand-600 hover:underline">
            Terms of Service
          </a>
        </div>
      </article>
    </main>
  );
}
