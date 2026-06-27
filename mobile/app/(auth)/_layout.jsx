// Auth-stack layout — login, password reset, etc. Headers are hidden;
// each screen draws its own. iOS modal presentation isn't used here so
// that the keyboard behaves naturally over the login form.
//
// Session guard — the exact inverse of (tabs)/_layout.jsx (which kicks a
// session-less user back here). Once a session exists we must leave the
// auth stack. This matters most on a paired STUDIO device: the PIN pad
// is an overlay rendered above whatever screen is underneath, and on a
// signed-out / cold-started device that screen is /(auth)/login. A
// correct PIN mints a Supabase session and unmounts the pad, but nothing
// else navigates — `index.jsx` only redirects at "/", and the PIN path
// (unlike email sign-in) never calls router.replace. Without this guard
// the staffer is stranded on the login screen holding a valid session,
// and re-pairing does nothing (the pad won't re-show while a session
// exists). Redirecting here on `session` closes that gap for every auth
// screen at once.

import { Stack, Redirect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'

export default function AuthLayout() {
  const { session, loading } = useAuth()
  if (loading) return null
  if (session) return <Redirect href="/(tabs)" />
  return <Stack screenOptions={{ headerShown: false }} />
}
