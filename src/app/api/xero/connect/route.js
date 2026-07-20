// Kicks off the Xero OAuth 2.0 authorization-code flow.
// User clicks "Connect Xero" in Settings → we sign a `state` token
// containing the location_id + a CSRF nonce, set it as an httpOnly
// cookie, and redirect them to login.xero.com. The callback verifies
// the cookie matches the returned state.

import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { buildAuthorizeUrl } from '@/lib/xero/client'
import { safeReturnTo, encodeReturnTo } from '@/lib/xero/return-to'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  // Connecting a Xero org is an owner/master finance-admin action.
  // (Previously gated on the car_processing permission — a holdover
  // from when Xero existed only for the CCF Autos car-invoice push.)
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  // IDOR guard — only start the OAuth flow for a location the caller
  // belongs to (master sees every location).
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  // CSRF: the cookie value is what we trust on callback. Encode the
  // location_id alongside a random nonce so we know which location
  // the round-trip belongs to.
  //
  // Optional post-connect redirect (`return_to`): the hub's inline Connect
  // button passes `?return_to=/settings/integrations-hub` so the callback
  // returns the browser to the hub instead of the per-location Xero tab.
  // It is carried INSIDE the signed `state` (base64url, appended after a
  // "."), so it is bound to the same value stored in the httpOnly cookie —
  // a tampered return_to fails the callback's cookie==state check before it
  // is read. It is validated to an INTERNAL PATH here (open-redirect guard)
  // and re-validated on callback; an invalid value is simply dropped and the
  // callback uses its existing default redirect.
  const nonce = randomBytes(24).toString('hex')
  const returnTo = safeReturnTo(url.searchParams.get('return_to'))
  const state = returnTo
    ? `${nonce}.${locationId}.${encodeReturnTo(returnTo)}`
    : `${nonce}.${locationId}`

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
