// Entry route — PHASE2 stage C: THE identity resolver. Decides which
// shell owns this launch.
//
//   no session          → staff login exactly as before the merge
//   kiosk pairing       → staff shell ONLY (member mode suppressed)
//   impersonating       → staff shell (member mode suppressed)
//   staff-only          → /(staff)/(tabs)
//   member-only         → /(member)/(tabs)/home
//   dual                → last-used side (first launch defaults staff)
//   confirmed neither   → /account-not-set-up
//
// The matrix itself is pure + unit-tested (lib/identity.js
// resolveEntryRoute); IdentityProvider (root layout) runs the time-boxed
// probes and hands us the computed entryRoute. While it resolves we render
// nothing — the splash is still up (SplashGate holds it until the
// resolution settles), so there is no flash of the wrong shell.

import { Redirect } from 'expo-router'
import { useAuth } from '../lib/auth-context'
import { useIdentity } from '../lib/identity-context'

export default function Index() {
  const { session, loading } = useAuth()
  const { resolving, entryRoute } = useIdentity()
  if (loading) return null
  if (!session) return <Redirect href="/(staff)/(auth)/login" />
  if (resolving || !entryRoute) return null
  return <Redirect href={entryRoute} />
}
