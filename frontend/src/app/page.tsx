'use client';

import Link from 'next/link';
import {
  MessagesSquare,
  Inbox,
  Megaphone,
  Bot,
  FileText,
  BarChart3,
  ShoppingBag,
  ShieldCheck,
  Clock,
  Building2,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import FeatureSlider from '@/components/landing/feature-slider';
import PricingSection from '@/components/landing/pricing-section';

const FEATURES = [
  {
    icon: Inbox,
    title: 'Shared Team Inbox',
    desc: 'A real-time, multi-agent WhatsApp inbox. Assign conversations, reply with media, voice notes and quick replies — together.',
  },
  {
    icon: Megaphone,
    title: 'Broadcast Campaigns',
    desc: 'Build campaigns with a guided wizard, segment your audience and personalize every message. Watch delivery progress live.',
  },
  {
    icon: Bot,
    title: 'Keyword Automation',
    desc: 'Set up keyword bots that auto-reply, tag, assign and trigger webhooks — so routine questions answer themselves.',
  },
  {
    icon: FileText,
    title: 'WhatsApp Templates',
    desc: 'Create message templates in-app and sync approval status straight from Meta. Reach customers outside the 24-hour window.',
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    desc: 'Track messages, reply rates, response times and agent performance with a clean, range-aware dashboard.',
  },
  {
    icon: ShoppingBag,
    title: 'Shopify Orders',
    desc: 'Create and confirm Shopify orders right inside the chat — COD or prepaid — and auto-tag orders from customer replies.',
  },
];

const VALUES = [
  {
    icon: ShieldCheck,
    title: 'Secure by design',
    desc: 'Your Meta and Shopify tokens are encrypted at rest with AES-256-GCM. Each tenant is fully isolated.',
  },
  {
    icon: Clock,
    title: '24-hour window aware',
    desc: 'The composer knows the WhatsApp service window and switches to templates automatically — no failed sends.',
  },
  {
    icon: MessagesSquare,
    title: 'Built on the official API',
    desc: 'Powered by the Meta WhatsApp Cloud API — reliable delivery, real-time webhooks, no unofficial workarounds.',
  },
  {
    icon: Building2,
    title: 'Made by Codentra',
    desc: 'A Pakistan-based product team building practical automation for growing businesses.',
  },
];

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-green-500 text-white shadow-sm">
        <MessagesSquare size={20} />
      </span>
      <span className="text-lg font-bold tracking-tight text-gray-900">CodesApp</span>
    </div>
  );
}

export default function LandingPage() {
  // Read the session only to adapt the CTAs — never block render on `loading`
  // (this is a public page; logged-out visitors are the common case).
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* ───────────── Nav ───────────── */}
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Brand />
          <nav className="flex items-center gap-2 sm:gap-3">
            {user ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-600"
              >
                Go to Dashboard <ArrowRight size={16} />
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition hover:text-gray-900"
                >
                  Sign In
                </Link>
                <Link
                  href="/register"
                  className="rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-600"
                >
                  Get Started
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* ───────────── Hero ───────────── */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-green-50 via-white to-white" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
            <MessagesSquare size={14} /> WhatsApp CRM & Automation
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-gray-900 sm:text-5xl">
            Turn WhatsApp into your
            <span className="text-green-600"> sales & support engine</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-600">
            CodesApp is a multi-tenant WhatsApp CRM for growing teams — a shared inbox, broadcast
            campaigns, automation bots, analytics and Shopify orders, all in one place.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {user ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-xl bg-green-500 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-green-600"
              >
                Go to Dashboard <ArrowRight size={18} />
              </Link>
            ) : (
              <>
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 rounded-xl bg-green-500 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-green-600"
                >
                  Get Started Free <ArrowRight size={18} />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-6 py-3 text-base font-semibold text-gray-700 transition hover:bg-gray-50"
                >
                  Sign In
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ───────────── Feature grid ───────────── */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">Everything your team needs</h2>
          <p className="mt-3 text-gray-600">
            One platform to message, automate and grow — no more juggling tools.
          </p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-gray-100 bg-white p-6 shadow-sm transition hover:border-green-200 hover:shadow-md"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-50 text-green-600 transition group-hover:bg-green-500 group-hover:text-white">
                <f.icon size={22} />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────────── Features slider ───────────── */}
      <section className="border-y border-gray-100 bg-gray-50">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900">See it in action</h2>
            <p className="mt-3 text-gray-600">A closer look at the screens your team will live in.</p>
          </div>
          <div className="mt-12">
            <FeatureSlider />
          </div>
        </div>
      </section>

      {/* ───────────── Pricing (dynamic, super-admin controlled) ───────────── */}
      <PricingSection />

      {/* ───────────── Why band ───────────── */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {VALUES.map((v) => (
            <div key={v.title} className="text-center sm:text-left">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-green-50 text-green-600 sm:mx-0">
                <v.icon size={22} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-gray-900">{v.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{v.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────────── Final CTA ───────────── */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-green-500 to-emerald-600 px-6 py-14 text-center shadow-xl sm:px-12">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Start automating your WhatsApp today
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-green-50">
            Join businesses using CodesApp to reply faster, sell more and keep every conversation in
            one place.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {user ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-base font-semibold text-green-700 shadow-sm transition hover:bg-green-50"
              >
                Go to Dashboard <ArrowRight size={18} />
              </Link>
            ) : (
              <>
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-base font-semibold text-green-700 shadow-sm transition hover:bg-green-50"
                >
                  Get Started Free <ArrowRight size={18} />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/40 px-6 py-3 text-base font-semibold text-white transition hover:bg-white/10"
                >
                  Sign In
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ───────────── Footer ───────────── */}
      <footer className="border-t border-gray-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
          <Brand />
          <p className="text-sm text-gray-500">
            © {new Date().getFullYear()} CodesApp. A{' '}
            <a
              href="https://codentra.pk"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-green-600 hover:underline"
            >
              Codentra
            </a>{' '}
            product.
          </p>
        </div>
      </footer>
    </div>
  );
}
