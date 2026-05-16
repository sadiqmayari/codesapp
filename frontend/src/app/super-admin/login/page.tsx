'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { api, setAccessToken } from '@/lib/api';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
type FormValues = z.infer<typeof schema>;

export default function SuperAdminLoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    setError('');
    try {
      const res = await api.post<{ data: { accessToken: string } }>(
        '/super-admin/auth/login',
        data,
      );
      setAccessToken(res.data.data.accessToken);
      router.push('/super-admin/dashboard');
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Login failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="w-full max-w-sm bg-gray-800 rounded-2xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-white">CodesApp</h1>
          <p className="text-gray-400 text-sm mt-1">Super Admin Access</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <input
              {...register('email')}
              type="email"
              placeholder="Admin email"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div className="relative">
            <input
              {...register('password')}
              type={showPw ? 'text' : 'password'}
              placeholder="Password"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 pr-10 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
            >
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-green-500 hover:bg-green-600 text-white font-semibold py-2 rounded-lg disabled:opacity-50 transition"
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
