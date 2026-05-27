// STUDIO-PIN.3 — POST /api/auth/studio-heartbeat
//
// Refresh the studio_session cookie's `last_act` timestamp so the
// 5-min idle timer resets. The client fires this on user activity
// (debounced to ~once a minute) — when the user stops interacting
// the heartbeats stop, the timestamp goes stale, and the cookie
// flips to idle_locked status on the next request.
//
// Idle-locked cookies are NOT refreshed by this endpoint — that's
// the lock state. To clear the lock the client must re-enter the
// PIN via /api/auth/pin-login, which mints a brand-new cookie.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  COOKIE_NAME,
  cookieAttributes,
  refreshStudioSession,
} from '@/lib/studio-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const cookieStore = await cookies()
  const current = cookieStore.get(COOKIE_NAME)?.value
  if (!current) {
    return NextResponse.json({ success: false, error: 'No studio session' }, { status: 401 })
  }
  const refreshed = refreshStudioSession(current)
  if (!refreshed) {
    // Cookie was invalid, idle-locked, or hard-expired. The client
    // should redirect to the PIN screen.
    return NextResponse.json({ success: false, error: 'Session is locked or expired' }, { status: 401 })
  }
  const res = NextResponse.json({ success: true })
  res.headers.append('Set-Cookie', `${COOKIE_NAME}=${refreshed}; ${cookieAttributes()}`)
  return res
}
