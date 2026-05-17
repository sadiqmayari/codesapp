'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, Copy, ExternalLink, RotateCcw } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

// Resolve the public origin at RUNTIME from the browser. NEXT_PUBLIC_* is
// inlined at build time and the build is produced off-host, so a build-time
// env would bake `localhost` into production (same bug class as lib/api.ts).
// The Meta webhook lives at the root origin (it is excluded from the /api
// prefix), so the callback URL is `${origin}/webhooks/meta`.
function publicOrigin(): string {
  if (typeof window !== 'undefined') return window.location.origin;
  return (
    process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
  ).replace(/\/+$/, '');
}

interface Status {
  step: number;
  completed: boolean;
  metaAppId: string | null;
  metaAccessToken: string | null;
  webhookVerifiedAt: string | null;
  testMessageSentAt: string | null;
  currentStep: number;
  webhookKey: string | null;
  webhookVerifyToken: string | null;
  webhookSecretSet: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
}

const STEPS = [
  { n: 1, title: 'Meta App', desc: 'Create your Meta app' },
  { n: 2, title: 'Webhook', desc: 'Verify the callback URL' },
  { n: 3, title: 'Access Token', desc: 'Securely store your token' },
  { n: 4, title: 'WABA & Phone', desc: 'Link your WhatsApp number' },
  { n: 5, title: 'Test Message', desc: 'Send a test & finish' },
];

export default function OnboardingPage() {
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [confetti, setConfetti] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // When set, the panel shows this (already-completed) step's form so the
  // user can re-submit it (e.g. a new access token) without a full reset.
  const [viewStep, setViewStep] = useState<number | null>(null);

  const refetch = useCallback(async () => {
    const s = await apiFetch<Status>('/onboarding/status', {
      noOnboardingRedirect: true,
    });
    setStatus(s);
    setLoading(false);
    return s;
  }, []);

  useEffect(() => {
    refetch().catch(() => setLoading(false));
  }, [refetch]);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.location.protocol !== 'https:' &&
      process.env.NODE_ENV === 'production'
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        '[onboarding] Not on HTTPS — the Meta access token must only be submitted over HTTPS in production.',
      );
    }
  }, []);

  const current = status ? (status.completed ? 6 : status.step) : 1;
  // Steps reachable for re-editing: any step before the current one, or all
  // five once onboarding is complete.
  const maxEditable = status?.completed ? 5 : current - 1;
  const panel = viewStep ?? current;

  const advance = async () => {
    setViewStep(null);
    const s = await refetch();
    if (s.completed) {
      setConfetti(true);
    }
  };

  const doReset = async () => {
    try {
      await apiFetch('/onboarding/reset', {
        method: 'POST',
        noOnboardingRedirect: true,
      });
      setResetOpen(false);
      setConfetti(false);
      toast.success('Onboarding reset.');
      await refetch();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Reset failed',
      );
    }
  };

  if (loading) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          WhatsApp Cloud API Setup
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Connect your Meta WhatsApp Business account to start messaging.
        </p>
      </div>

      {/* Mobile progress bar */}
      <div className="md:hidden mb-6">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
          <span>
            Step {Math.min(current, 5)} of 5
          </span>
          <span>{Math.round((Math.min(current - 1, 5) / 5) * 100)}%</span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all"
            style={{
              width: `${(Math.min(current - 1, 5) / 5) * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Vertical stepper (desktop) */}
        <ol className="hidden md:block w-64 shrink-0 space-y-1">
          {STEPS.map((st) => {
            const done = current > st.n;
            const active = panel === st.n;
            const editable = st.n <= maxEditable;
            return (
              <li
                key={st.n}
                onClick={() => editable && setViewStep(st.n)}
                title={editable ? 'Click to re-enter this step' : undefined}
                className={cn(
                  'flex items-start gap-3 rounded-lg px-3 py-3',
                  active && 'bg-green-50',
                  editable && 'cursor-pointer hover:bg-gray-50',
                )}
              >
                <span
                  className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center text-sm font-semibold shrink-0',
                    done && 'bg-green-500 text-white',
                    active && 'bg-green-600 text-white',
                    !done && !active && 'bg-gray-200 text-gray-500',
                  )}
                >
                  {done ? <Check size={16} /> : st.n}
                </span>
                <div>
                  <p
                    className={cn(
                      'text-sm font-medium',
                      active ? 'text-green-700' : 'text-gray-700',
                    )}
                  >
                    {st.title}
                  </p>
                  <p className="text-xs text-gray-400">{st.desc}</p>
                  {done && (
                    <span className="text-xs text-green-600 font-medium">
                      Connected ✓
                      {editable && (
                        <span className="text-gray-400 font-normal">
                          {' '}
                          · Edit
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Current step panel */}
        <div className="flex-1 bg-white border border-gray-200 rounded-2xl p-6 sm:p-8">
          {/* Mobile: jump back to a completed step to re-enter it */}
          {maxEditable >= 1 && (
            <div className="md:hidden mb-5 flex flex-wrap gap-2">
              {STEPS.filter((st) => st.n <= maxEditable).map((st) => (
                <button
                  key={st.n}
                  onClick={() => setViewStep(st.n)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs',
                    panel === st.n
                      ? 'border-green-600 text-green-700 bg-green-50'
                      : 'border-gray-300 text-gray-600',
                  )}
                >
                  Edit {st.n}. {st.title}
                </button>
              ))}
            </div>
          )}

          {viewStep !== null && viewStep !== current && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2.5 text-sm text-amber-800">
              <span>
                Re-entering step {viewStep}. Only this step is updated;
                already-saved secrets in later steps are kept (leave their
                fields blank) — just click through to the end.
              </span>
              <button
                onClick={() => setViewStep(null)}
                className="shrink-0 text-amber-700 underline"
              >
                Cancel
              </button>
            </div>
          )}

          {panel === 1 && <Step1 onDone={advance} />}
          {panel === 2 && (
            <Step2
              verifiedAt={status?.webhookVerifiedAt ?? null}
              webhookKey={status?.webhookKey ?? null}
              verifyToken={status?.webhookVerifyToken ?? null}
              secretSet={status?.webhookSecretSet ?? false}
              onDone={advance}
            />
          )}
          {panel === 3 && (
            <Step3
              onDone={advance}
              tokenSet={!!status?.metaAccessToken}
            />
          )}
          {panel === 4 && (
            <Step4
              onDone={advance}
              wabaId={status?.wabaId ?? null}
              phoneNumberId={status?.phoneNumberId ?? null}
            />
          )}
          {panel === 5 && (
            <Step5
              onDone={advance}
              isOwner={user?.role === 'owner'}
            />
          )}
          {panel >= 6 && (
            <FinishScreen
              confetti={confetti}
              onGo={() => router.push('/dashboard')}
            />
          )}

          {user?.role === 'owner' && (
            <div className="mt-8 pt-6 border-t border-gray-100">
              <button
                onClick={() => setResetOpen(true)}
                className="text-sm text-red-600 hover:underline flex items-center gap-1.5"
              >
                <RotateCcw size={14} />
                Reset onboarding
              </button>
            </div>
          )}
        </div>
      </div>

      {resetOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 max-w-sm w-full">
            <h3 className="font-semibold text-lg text-gray-900">
              Reset onboarding?
            </h3>
            <p className="text-sm text-gray-500 mt-2">
              This clears your Meta credentials and sends you back to step 1.
              Contacts and messages are not deleted.
            </p>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setResetOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={doReset}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepHeading({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-gray-900">{title}</h2>
      {children && (
        <p className="text-sm text-gray-500 mt-1">{children}</p>
      )}
    </div>
  );
}

function SubmitBtn({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50 transition"
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

/* ---------------- Step 1 ---------------- */
const step1Schema = z.object({
  metaAppId: z.string().min(1, 'Meta App ID is required'),
});
function Step1({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ metaAppId: string }>({
    resolver: zodResolver(step1Schema),
  });

  const submit = handleSubmit(async (data) => {
    try {
      await apiFetch('/onboarding/step-1-meta-app', {
        method: 'POST',
        body: data,
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  });

  return (
    <form onSubmit={submit}>
      <StepHeading title="Create your Meta App">
        Create an app in the Meta Developer console and add the WhatsApp
        product to it.
      </StepHeading>
      <a
        href="https://developers.facebook.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-green-600 hover:underline text-sm mb-6"
      >
        Open Meta for Developers <ExternalLink size={14} />
      </a>
      <ol className="list-decimal list-inside text-sm text-gray-600 space-y-1.5 mb-6">
        <li>Create a Business app.</li>
        <li>Add the “WhatsApp” product.</li>
        <li>Copy the App ID from the app dashboard.</li>
      </ol>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Meta App ID
      </label>
      <input
        {...register('metaAppId')}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="123456789012345"
      />
      {errors.metaAppId && (
        <p className="text-red-500 text-sm mb-3">
          {errors.metaAppId.message}
        </p>
      )}
      <div className="mt-6">
        <SubmitBtn loading={isSubmitting}>Mark as done</SubmitBtn>
      </div>
    </form>
  );
}

/* ---------------- Step 2 ---------------- */
function Step2({
  verifiedAt,
  webhookKey,
  verifyToken: savedVerifyToken,
  secretSet,
  onDone,
}: {
  verifiedAt: string | null;
  webhookKey: string | null;
  verifyToken: string | null;
  secretSet: boolean;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [appSecret, setAppSecret] = useState('');
  const callbackUrl = webhookKey
    ? `${publicOrigin()}/webhooks/meta/${webhookKey}`
    : `${publicOrigin()}/webhooks/meta`;

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed'),
    );
  };

  const confirm = async () => {
    if (!secretSet && appSecret.trim().length < 10) {
      toast.error('Enter your Meta app secret');
      return;
    }
    setBusy(true);
    try {
      const trimmedSecret = appSecret.trim();
      await apiFetch('/onboarding/step-2-webhook-verify', {
        method: 'POST',
        noOnboardingRedirect: true,
        // Omit appSecret when blank → backend keeps the stored one.
        body: trimmedSecret ? { appSecret: trimmedSecret } : {},
      });
      await onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StepHeading title="Connect your webhook">
        In your Meta app → WhatsApp → Configuration, paste the{' '}
        <strong>callback URL</strong> and <strong>verify token</strong> below
        (both generated for you), subscribe the <strong>messages</strong>{' '}
        field, then enter your app secret here.
      </StepHeading>

      <label className="block text-xs font-medium text-gray-500 mb-1">
        Your callback URL (unique to this account)
      </label>
      <div className="flex items-center gap-2 mb-5">
        <code className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-sm break-all">
          {callbackUrl}
        </code>
        <button
          type="button"
          onClick={() => copy(callbackUrl)}
          className="p-2 text-gray-500 hover:text-gray-800"
          aria-label="Copy callback URL"
        >
          <Copy size={16} />
        </button>
      </div>

      <label className="block text-xs font-medium text-gray-500 mb-1">
        Verify token (auto-generated — paste this exact value into Meta)
      </label>
      <div className="flex items-center gap-2 mb-5">
        <code className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-sm break-all">
          {savedVerifyToken ?? '(generating…)'}
        </code>
        <button
          type="button"
          onClick={() => savedVerifyToken && copy(savedVerifyToken)}
          className="p-2 text-gray-500 hover:text-gray-800"
          aria-label="Copy verify token"
        >
          <Copy size={16} />
        </button>
      </div>

      <label className="block text-sm font-medium text-gray-700 mb-1">
        Meta app secret{' '}
        {secretSet && (
          <span className="text-xs text-green-600">
            (already saved — leave blank to keep)
          </span>
        )}
      </label>
      <input
        value={appSecret}
        onChange={(e) => setAppSecret(e.target.value)}
        type="password"
        autoComplete="off"
        placeholder={secretSet ? '•••••••• (unchanged)' : 'App → Settings → Basic → App secret'}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      <p className="text-xs text-gray-500 mb-5">
        Stored encrypted. Used to validate that inbound messages really come
        from Meta. Find it in your Meta app → <strong>Settings → Basic →
        App secret</strong>. This is <strong>not</strong> the access token —
        that&apos;s a separate value you&apos;ll paste in the next step.
      </p>

      {verifiedAt && (
        <p className="text-sm text-green-600 mb-4">
          Webhook configured ✓ ({new Date(verifiedAt).toLocaleString()})
        </p>
      )}

      <button
        type="button"
        onClick={confirm}
        disabled={busy}
        className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save & continue'}
      </button>
    </div>
  );
}

/* ---------------- Step 3 ---------------- */
function Step3({
  onDone,
  tokenSet,
}: {
  onDone: () => Promise<void>;
  tokenSet: boolean;
}) {
  const toast = useToast();
  const [encError, setEncError] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const t = token.trim();
    if (!t && !tokenSet) {
      toast.error('Paste a permanent System User access token');
      return;
    }
    if (t && t.length < 10) {
      toast.error('Access token looks too short');
      return;
    }
    setEncError(false);
    setBusy(true);
    try {
      await apiFetch('/onboarding/step-3-access-token', {
        method: 'POST',
        // Omit when blank → backend keeps the previously stored token.
        body: t ? { accessToken: t } : {},
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setEncError(true); // keep token in the input — do NOT retry
      } else {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StepHeading title="Add your access token">
        Paste a permanent System User access token (starts with{' '}
        <code>EAAG…</code>) from your Meta app. This is a{' '}
        <strong>different</strong> value from the App Secret in step 2 — the
        token is used to send messages; the App Secret validates incoming
        ones. Encrypted at rest and never shown again.
      </StepHeading>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Meta Access Token{' '}
        {tokenSet && (
          <span className="text-xs text-green-600">
            (already saved — leave blank to keep)
          </span>
        )}
      </label>
      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        type="password"
        autoComplete="off"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder={tokenSet ? '•••••••• (unchanged)' : 'EAAG...'}
      />
      {encError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 my-3">
          Server encryption is not configured. Contact your administrator. Your
          token was <strong>not</strong> stored — it remains in the field above
          so you can copy it elsewhere if needed.
        </div>
      )}
      <div className="mt-6">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50 transition"
        >
          {busy ? 'Working…' : 'Save & continue'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Step 4 ---------------- */
const step4Schema = z.object({
  wabaId: z.string().min(1, 'WABA ID is required'),
  phoneNumberId: z.string().min(1, 'Phone Number ID is required'),
});
function Step4({
  onDone,
  wabaId,
  phoneNumberId,
}: {
  onDone: () => Promise<void>;
  wabaId: string | null;
  phoneNumberId: string | null;
}) {
  const toast = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ wabaId: string; phoneNumberId: string }>({
    resolver: zodResolver(step4Schema),
    defaultValues: {
      wabaId: wabaId ?? '',
      phoneNumberId: phoneNumberId ?? '',
    },
  });

  const submit = handleSubmit(async (data) => {
    try {
      await apiFetch('/onboarding/step-4-waba-phone', {
        method: 'POST',
        body: data,
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  });

  return (
    <form onSubmit={submit}>
      <StepHeading title="Link your WhatsApp number">
        Find these in Meta app → WhatsApp → API Setup.
      </StepHeading>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        WhatsApp Business Account ID (WABA)
      </label>
      <input
        {...register('wabaId')}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="102290129340398"
      />
      {errors.wabaId && (
        <p className="text-red-500 text-sm mb-2">{errors.wabaId.message}</p>
      )}
      <label className="block text-sm font-medium text-gray-700 mb-1 mt-4">
        Phone Number ID
      </label>
      <input
        {...register('phoneNumberId')}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="106540352242922"
      />
      {errors.phoneNumberId && (
        <p className="text-red-500 text-sm mb-2">
          {errors.phoneNumberId.message}
        </p>
      )}
      <div className="mt-6">
        <SubmitBtn loading={isSubmitting}>Save & continue</SubmitBtn>
      </div>
    </form>
  );
}

/* ---------------- Step 5 ---------------- */
const step5Schema = z.object({
  toPhone: z
    .string()
    .regex(/^\+?[1-9]\d{6,15}$/, 'Use international format, e.g. +14155552671'),
  templateName: z.string().min(1, 'Template name is required'),
  languageCode: z.string().min(2, 'Language code is required'),
});
function Step5({
  onDone,
  isOwner,
}: {
  onDone: () => Promise<void>;
  isOwner: boolean;
}) {
  const toast = useToast();
  const [params, setParams] = useState<string[]>([]);
  const [skipping, setSkipping] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{
    toPhone: string;
    templateName: string;
    languageCode: string;
  }>({
    resolver: zodResolver(step5Schema),
    defaultValues: { templateName: 'hello_world', languageCode: 'en_US' },
  });

  const submit = handleSubmit(async (data) => {
    const bodyParams = params.map((p) => p.trim()).filter(Boolean);
    try {
      await apiFetch('/onboarding/step-5-test-message', {
        method: 'POST',
        body: bodyParams.length ? { ...data, bodyParams } : data,
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Test message failed',
      );
    }
  });

  const skip = async () => {
    setSkipping(true);
    try {
      await apiFetch('/onboarding/complete', {
        method: 'POST',
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not finish onboarding',
      );
    } finally {
      setSkipping(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepHeading title="Send a test message">
        Send an approved template to a number that has opted in. The default
        <code className="mx-1">hello_world</code> template works for most new
        accounts.
      </StepHeading>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Recipient phone (E.164)
      </label>
      <input
        {...register('toPhone')}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="+14155552671"
      />
      {errors.toPhone && (
        <p className="text-red-500 text-sm mb-2">{errors.toPhone.message}</p>
      )}
      <div className="grid grid-cols-2 gap-4 mt-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Template name
          </label>
          <input
            {...register('templateName')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {errors.templateName && (
            <p className="text-red-500 text-sm">
              {errors.templateName.message}
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Language code
          </label>
          <input
            {...register('languageCode')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {errors.languageCode && (
            <p className="text-red-500 text-sm">
              {errors.languageCode.message}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Template variables (optional)
        </label>
        <p className="text-xs text-gray-500 mb-2">
          If the template uses <code>{'{{1}}'}</code>,{' '}
          <code>{'{{2}}'}</code>… add one value per placeholder, in order.
          Leave empty for a no-variable template.
        </p>
        <div className="space-y-2">
          {params.map((p, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-10 shrink-0 text-sm text-gray-500 pt-2">
                {`{{${i + 1}}}`}
              </span>
              <input
                value={p}
                onChange={(e) =>
                  setParams((c) =>
                    c.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder={`Value for {{${i + 1}}}`}
              />
              <button
                type="button"
                onClick={() =>
                  setParams((c) => c.filter((_, j) => j !== i))
                }
                className="px-3 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setParams((c) => [...c, ''])}
          className="mt-2 text-sm text-green-600 hover:underline"
        >
          + Add variable
        </button>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SubmitBtn loading={isSubmitting}>Send test &amp; finish</SubmitBtn>
        {isOwner && (
          <button
            type="button"
            onClick={skip}
            disabled={skipping}
            className="text-sm text-gray-600 hover:text-gray-900 underline disabled:opacity-50"
          >
            {skipping
              ? 'Finishing…'
              : 'Skip test & finish (connection already verified)'}
          </button>
        )}
      </div>
      {isOwner && (
        <p className="text-xs text-gray-400 mt-2">
          Skipping marks onboarding complete without sending a test — use this
          if all your approved templates require variables. Token, WABA and
          phone number are already validated.
        </p>
      )}
    </form>
  );
}

/* ---------------- Finish ---------------- */
function FinishScreen({
  confetti,
  onGo,
}: {
  confetti: boolean;
  onGo: () => void;
}) {
  return (
    <div className="text-center py-10">
      <div className="text-6xl mb-4">{confetti ? '🎉' : '✅'}</div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        You&apos;re all set!
      </h2>
      <p className="text-gray-500 mb-8">
        Your WhatsApp Cloud API connection is live. You can now receive and
        send messages.
      </p>
      <button
        onClick={onGo}
        className="bg-green-600 hover:bg-green-700 text-white font-semibold px-6 py-3 rounded-lg"
      >
        Go to Dashboard
      </button>
    </div>
  );
}
