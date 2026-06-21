// src/lib/studio-session-mint.js
//
// Mint a real Supabase session for a profile WITHOUT a password — used
// by the studio-device PIN login on native. The iPad has no cookie to
// carry the studio_session envelope and reads Supabase directly, so each
// PIN must produce a genuine Supabase access+refresh pair the app can
// setSession() with.
//
// Mechanism (all server-side, NO email sent):
//   1. admin.getUserById  → the profile's canonical auth email
//   2. admin.generateLink → a magiclink hashed_token (generated, not emailed)
//   3. verifyOtp          → exchange the hash for a live session
//
// generateLink + verifyOtp are the documented passwordless-session path
// in @supabase/supabase-js (>=2.45). If a later live test finds that
// verifyOtp needs type:'email' rather than 'magiclink', change BOTH the
// generateLink type and the verifyOtp type to match what worked.

import { createClient } from '@supabase/supabase-js'

export async function mintSupabaseSession({ admin, profileId }) {
  if (!profileId) throw new Error('mintSupabaseSession: profileId required')

  // 1. Canonical auth email (robust to profiles.email drift).
  const { data: got, error: e1 } = await admin.auth.admin.getUserById(profileId)
  const email = got?.user?.email
  if (e1 || !email) throw new Error('mintSupabaseSession: could not resolve auth email')

  // 2. Magiclink hashed token — generated, NOT emailed.
  const { data: link, error: e2 } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (e2 || !tokenHash) throw new Error('mintSupabaseSession: generateLink failed')

  // 3. Exchange for a session on a throwaway anon client (no persistence).
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: verified, error: e3 } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })
  const session = verified?.session
  if (e3 || !session?.access_token || !session?.refresh_token) {
    throw new Error('mintSupabaseSession: verifyOtp returned no session')
  }
  return { access_token: session.access_token, refresh_token: session.refresh_token }
}
