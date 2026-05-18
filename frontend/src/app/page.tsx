import { redirect } from 'next/navigation';

// Send the bare domain into the app, not unconditionally to /login.
// `middleware.ts` then allows it through if the refresh_token cookie is
// present (the (app) layout silently refreshes and restores the session);
// only a genuinely logged-out visitor (no cookie) is bounced to /login.
export default function RootPage() {
  redirect('/dashboard');
}
