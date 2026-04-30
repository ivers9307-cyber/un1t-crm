// Kicks off the Xero OAuth 2.0 authorization-code flow.
// User clicks "Connect Xero" in Settings → we sign a `state` token
// containing the location_id + a CSRF nonce, set it as an httpOnly
// cookie, and redirect them to login.xero.com. The callback verifies
// the cookie matches the returned state.

import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { buildAuthorizeUrl } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }

  // CSRF: the cookie value is what we trust on callback. Encode the
  // location_id alongside a random nonce so we know which location
  // the round-trip belongs to.
  const nonce = randomBytes(24).toString('hex')
  const state = `${nonce}.${locationId}`

  const authorizeUrl = buildAuthorizeUrl({ state })
  const res = NextResponse.redirect(authorizeUrl)
  res.cookies.set('xero_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes is plenty for an auth handshake
    path: '/',
  })
  return res
}
