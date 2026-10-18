import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { sendBroadcast } from '@/lib/whatsapp'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'
import { routeSignoffFor, writeSignoffStamp, isBlastSignoffRequired } from '@/lib/whatsapp-blast-signoff'

// POST /api/whatsapp/broadcasts/[id]/send
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })
  }

  // Authorise BEFORE we let sendBroadcast take over — it's an
  // internal helper and doesn't repeat the location check. (Mirrors
  // the SMS sibling; this route previously had no guard at all, so
  // any authenticated principal could fire any broadcast by id.)
  const db = createServerClient()
  const { data: row, error: rowErr } = await db.from('whatsapp_broadcasts')
    .select('location_id, signed_off_by').eq('id', params.id).maybeSingle()
  if (rowErr) return NextResponse.json({ success: false, error: 'Could not read the broadcast' }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  // ROLESWEEP.1a — the permission is judged at the broadcast's location.
  if (!hasPermissionForLocation(user, row.location_id, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })
  }

  // WAORGNUMBER.4 (R7) — blast sign-off, before the engine's 409 paths: while
  // the studio's window is open only an organisation admin (master passes)
  // may send an unsigned broadcast, and their send signs it off.
  let signoff
  try {
    signoff = await routeSignoffFor(db, { user, locationId: row.location_id, row })
  } catch {
    return NextResponse.json({ success: false, error: 'Could not check whether this broadcast needs sign-off. Try again.' }, { status: 503 })
  }
  if (signoff.blocked) return NextResponse.json({ success: false, error: signoff.blocked }, { status: 403 })
  if (signoff.stamp) {
    const stampErr = await writeSignoffStamp(db, params.id, signoff.stamp)
    if (stampErr) return NextResponse.json({ success: false, error: 'Could not record the sign-off; nothing was sent' }, { status: 500 })
  }

  // WA-QUALITY.2 — optional JSON body `{ force: true }` bypasses the
  // number-quality preflight refusal inside sendBroadcast (explicit
  // operator override). The body is optional; absent/invalid → no force.
  let force = false
  try {
    const body = await request.json()
    force = body?.force === true
  } catch {
    // no/invalid body — normal send
  }

  try {
    const result = await sendBroadcast(params.id, { force })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('Broadcast send error:', error)
    // WACONFIGFALLBACK.1 — no WhatsApp number at the broadcast's location is a
    // 409 (the blast used to go out on the env number); nothing was flipped.
    // WAORGNUMBER.4 — so is the engine's sign-off refusal.
    return NextResponse.json(
      { success: false, error: error.message },
      { status: isBlastSignoffRequired(error) ? 409 : whatsappErrorStatus(error, 400) }
    )
  }
}
