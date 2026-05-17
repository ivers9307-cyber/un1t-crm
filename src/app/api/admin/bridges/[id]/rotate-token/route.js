// POST /api/admin/bridges/[id]/rotate-token
//
// Master-only: invalidate the bridge's existing token and issue a
// fresh one. The Pi will fail authentication until reflashed with
// the new token, so use sparingly — typically when:
//   - the previous token leaked
//   - a Pi is being decommissioned and you want to revoke first
//
// Returns the new raw token in the response (shown once).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { issueBridgeToken } from '@/lib/bridge-auth'
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

  const { data, error } = await db
    .from('ble_bridges')
    .update({ api_token_hash: hash })
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
  })

  return NextResponse.json({
    ok: true,
    bridge: data,
    token: raw,
    setup_hint: 'Reflash the Pi with this token. Previous token is dead immediately.',
  })
}
