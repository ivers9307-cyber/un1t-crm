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

export async function GET() {
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

  const state = signState({ locationId, profileId: user.id, ts: Date.now() }, process.env.CRON_SECRET)
  return NextResponse.redirect(buildAuthorizeUrl(cfg, state))
}
