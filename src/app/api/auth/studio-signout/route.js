// STUDIO-PIN.3 — POST /api/auth/studio-signout
//
// Clear the studio_session cookie. Called when the staffer explicitly
// signs out (e.g. tapping a "lock and sign out" button) or when a
// shell decides to drop the device's session entirely. Doesn't touch
// any DB state — the cookie is the only thing that holds the PIN
// session, so clearing it is sufficient.

import { NextResponse } from 'next/server'
import { COOKIE_NAME } from '@/lib/studio-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const res = NextResponse.json({ success: true })
  // Max-Age=0 + the same Path/HttpOnly/SameSite flags so the
  // browser clears the cookie reliably across SameSite policies.
  res.headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  )
  return res
}
