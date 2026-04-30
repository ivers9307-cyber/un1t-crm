// Entry route. Decides where to send the user based on session state.
//
// While auth is loading we render nothing (the splash screen is still
// up — see app/_layout.jsx). Once loaded:
//   - session present → redirect to (tabs)
//   - no session       → redirect to (auth)/login

import { Redirect } from 'expo-router'
import { useAuth } from '../lib/auth-context'

export default function Index() {
  const { session, loading } = useAuth()
  if (loading) return null
  return <Redirect href={session ? '/(tabs)' : '/(auth)/login'} />
}
