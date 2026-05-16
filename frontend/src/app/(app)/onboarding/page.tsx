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

const APP_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Status {
  step: number;
  completed: boolean;
  metaAppId: string | null;
  metaAccessToken: string | null;
  webhookVerifiedAt: string | null;
  testMessageSentAt: string | null;
  currentStep: number;
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

  const advance = async () => {
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
            const active = current === st.n;
            return (
              <li
                key={st.n}
                className={cn(
                  'flex items-start gap-3 rounded-lg px-3 py-3',
                  active && 'bg-green-50',
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
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Current step panel */}
        <div className="flex-1 bg-white border border-gray-200 rounded-2xl p-6 sm:p-8">
          {current === 1 && <Step1 onDone={advance} />}
          {current === 2 && (
            <Step2
              verifiedAt={status?.webhookVerifiedAt ?? null}
              onDone={advance}
            />
          )}
          {current === 3 && <Step3 onDone={advance} />}
          {current === 4 && <Step4 onDone={advance} />}
          {current === 5 && <Step5 onDone={advance} />}
          {current >= 6 && (
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
  onDone,
}: {
  verifiedAt: string | null;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const callbackUrl = `${APP_URL}/webhooks/meta`;

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed'),
    );
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await apiFetch('/onboarding/step-2-webhook-verify', {
        method: 'POST',
        noOnboardingRedirect: true,
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
      <StepHeading title="Verify your webhook">
        In the Meta app → WhatsApp → Configuration, set the callback URL and
        verify token, then click verify in Meta.
      </StepHeading>

      <label className="block text-xs font-medium text-gray-500 mb-1">
        Callback URL
      </label>
      <div className="flex items-center gap-2 mb-4">
        <code className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-sm break-all">
          {callbackUrl}
        </code>
        <button
          onClick={() => copy(callbackUrl)}
          className="p-2 text-gray-500 hover:text-gray-800"
          aria-label="Copy callback URL"
        >
          <Copy size={16} />
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800 mb-6">
        The webhook <strong>verify token</strong> is configured server-side by
        your administrator (the <code>META_VERIFY_TOKEN</code> environment
        variable). Use the value your admin provided when Meta asks for the
        verify token.
      </div>

      {verifiedAt && (
        <p className="text-sm text-green-600 mb-4">
          Webhook verified ✓ ({new Date(verifiedAt).toLocaleString()})
        </p>
      )}

      <button
        onClick={confirm}
        disabled={busy}
        className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50"
      >
        {busy ? 'Working…' : "I've verified in Meta"}
      </button>
    </div>
  );
}

/* ---------------- Step 3 ---------------- */
const step3Schema = z.object({
  accessToken: z.string().min(10, 'Access token looks too short'),
});
function Step3({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [encError, setEncError] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ accessToken: string }>({
    resolver: zodResolver(step3Schema),
  });

  const submit = handleSubmit(async (data) => {
    setEncError(false);
    try {
      await apiFetch('/onboarding/step-3-access-token', {
        method: 'POST',
        body: data,
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setEncError(true); // keep token in the input — do NOT retry
      } else {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
      }
    }
  });

  return (
    <form onSubmit={submit}>
      <StepHeading title="Add your access token">
        Paste a permanent System User access token from your Meta app. It is
        encrypted at rest and never shown again.
      </StepHeading>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Meta Access Token
      </label>
      <input
        {...register('accessToken')}
        type="password"
        autoComplete="off"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="EAAG..."
      />
      {errors.accessToken && (
        <p className="text-red-500 text-sm mb-2">
          {errors.accessToken.message}
        </p>
      )}
      {encError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 my-3">
          Server encryption is not configured. Contact your administrator. Your
          token was <strong>not</strong> stored — it remains in the field above
          so you can copy it elsewhere if needed.
        </div>
      )}
      <div className="mt-6">
        <SubmitBtn loading={isSubmitting}>Save token</SubmitBtn>
      </div>
    </form>
  );
}

/* ---------------- Step 4 ---------------- */
const step4Schema = z.object({
  wabaId: z.string().min(1, 'WABA ID is required'),
  phoneNumberId: z.string().min(1, 'Phone Number ID is required'),
});
function Step4({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ wabaId: string; phoneNumberId: string }>({
    resolver: zodResolver(step4Schema),
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
function Step5({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
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
    try {
      await apiFetch('/onboarding/step-5-test-message', {
        method: 'POST',
        body: data,
        noOnboardingRedirect: true,
      });
      await onDone();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Test message failed',
      );
    }
  });

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
      <div className="mt-6">
        <SubmitBtn loading={isSubmitting}>Send test & finish</SubmitBtn>
      </div>
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
