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
//
// REPSET-PUB.3A — the target is "/" (app/index.jsx, THE identity resolver),
// not "/(tabs)". This guard RACES the login screen's own router.replace and
// usually wins, so a hard-coded staff destination here overrode whatever the
// screen decided: a member-only session — the App Store reviewer's demo
// account is one, and it must land on the member shell for review to pass —
// was shunted into the staff tabs regardless. The resolver answers STAFF_HOME
// for every case this guard was written for (a paired kiosk resolves to the
// staff shell with no probes at all), so staff behaviour is unchanged.

import { Stack, Redirect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'

export default function AuthLayout() {
  const { session, loading } = useAuth()
  if (loading) return null
  if (session) return <Redirect href="/" />
  return <Stack screenOptions={{ headerShown: false }} />
}
