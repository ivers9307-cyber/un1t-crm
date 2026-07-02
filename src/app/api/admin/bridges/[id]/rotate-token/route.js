// POST /api/admin/bridges/[id]/rotate-token
//
// Master-only: issue a fresh token for the bridge. Rotation is a
// dual-token grace swap (mig 345): the current hash moves into
// previous_token_hash with a TOKEN_GRACE_MS expiry and the new hash
// becomes api_token_hash, so the OLD token keeps working for the grace
// window while the Pi is updated — no HR-ingest downtime. Typical use:
//   - the previous token leaked (rotate, then let the grace window lapse
//     — or set a shorter window if you need an immediate revoke)
//   - routine hygiene rotation
//
// Returns the new raw token in the response (shown once) plus when the
// previous token stops working.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { issueBridgeToken, TOKEN_GRACE_MS } from '@/lib/bridge-auth'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const { raw, hash } = issueBridgeToken()
  const db = createServerClient()

  // Read the current hash first so we can move it into the grace slot. A
  // supabase-js .update() sends literal values, so we can't express
  // previous_token_hash = api_token_hash in one statement.
  const { data: existing, error: readErr } = await db
    .from('ble_bridges')
    .select('id, api_token_hash')
    .eq('id', params.id)
    .maybeSingle()

  if (readErr) {
    logWarn('bridge-admin', 'rotate-token read failed', { err: readErr, bridgeId: params.id })
    return NextResponse.json({ ok: false, error: readErr.message || 'rotate_failed' }, { status: 400 })
  }
  if (!existing) {
    return NextResponse.json({ ok: false, error: 'Bridge not found' }, { status: 404 })
  }

  const previousExpiresAt = new Date(Date.now() + TOKEN_GRACE_MS).toISOString()

  const { data, error } = await db
    .from('ble_bridges')
    .update({
      api_token_hash: hash,
      previous_token_hash: existing.api_token_hash,
      previous_token_expires_at: previousExpiresAt,
    })
    .eq('id', params.id)
    .select('id, name, hardware_id, location_id')
    .single()

  if (error || !data) {
    if (error?.code === 'PGRST116' || /not found/i.test(error?.message || '')) {
      return NextResponse.json({ ok: false, error: 'Bridge not found' }, { status: 404 })
    }
    logWarn('bridge-admin', 'rotate-token failed', { err: error, bridgeId: params.id })
    return NextResponse.json({ ok: false, error: error?.message || 'rotate_failed' }, { status: 400 })
  }

  logInfo('bridge-admin', 'bridge token rotated', {
    bridgeId: data.id,
    actor: user.id,
    previousTokenExpiresAt: previousExpiresAt,
  })

  return NextResponse.json({
    ok: true,
    bridge: data,
    token: raw,
    previous_token_expires_at: previousExpiresAt,
    setup_hint: 'Paste this token into the Pi. The previous token keeps working for 24h, so there is no rush and no HR-ingest downtime.',
  })
}
