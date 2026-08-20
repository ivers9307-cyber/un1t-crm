// SONOS.11 — starts the OAuth link. Staff-only; the state parameter is
// signed with CRON_SECRET so the callback can prove the round trip came
// from us and can recover which location is being linked without a
// server-side session store.

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { getSonosConfig, buildAuthorizeUrl } from '@/lib/sonos/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function signState(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  return `${raw}.${sig}`
}

export function verifyState(state, secret) {
  const [raw, sig] = String(state || '').split('.')
  if (!raw || !sig) return null
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString()) } catch { return null }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const cfg = getSonosConfig()
  if (!cfg) return NextResponse.json({ success: false, error: 'Sonos is not configured on this deploy' }, { status: 503 })
  if (cfg.error) return NextResponse.json({ success: false, error: cfg.error }, { status: 503 })
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET is required to sign the OAuth state' }, { status: 503 })
  }

  // Optional: set when the operator is RE-ENTERING this route after the
  // callback sent them to pick a household (see the `pick_household` guard
  // in the callback). It travels inside the SIGNED state, not as a callback
  // query param, because by the time the callback runs, the authorization
  // `code` from THAT attempt is already spent — codes are single-use and
  // short-lived, so a second callback request could never reuse it anyway.
  // Routing the re-pick back through here instead mints a fresh code AND a
  // fresh signed state carrying the choice, which is what makes the second
  // attempt actually completable.
  const url = new URL(request.url)
  const householdId = url.searchParams.get('household_id') || null

  const state = signState({ locationId, profileId: user.id, householdId, ts: Date.now() }, process.env.CRON_SECRET)
  return NextResponse.redirect(buildAuthorizeUrl(cfg, state))
}
