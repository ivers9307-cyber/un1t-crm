// Entry route. Decides where to send the user based on session state.
//
// While auth is loading we render nothing (the splash screen is still
// up — see app/_layout.jsx). Once loaded:
//   - session present → redirect to (staff)/(tabs)
//   - no session       → redirect to (staff)/(auth)/login
//
// PHASE2 (one-app merge) — THIS is the stage-C resolver site. Stage B
// keeps today's staff-only behaviour EXACTLY (every session lands in the
// staff tree; the ported (member) group is unreachable). Stage C replaces
// this redirect with the identity resolver that decides staff vs member
// (and the switcher semantics). The hrefs are group-qualified only because
// (member) now also has a (tabs) group — the resolved URLs are unchanged.

import { Redirect } from 'expo-router'
import { useAuth } from '../lib/auth-context'

export default function Index() {
  const { session, loading } = useAuth()
  if (loading) return null
  return <Redirect href={session ? '/(staff)/(tabs)' : '/(staff)/(auth)/login'} />
}
