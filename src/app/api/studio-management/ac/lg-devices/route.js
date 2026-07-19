// GET /api/studio-management/ac/lg-devices?pat=...&client_id=...&country=IE
//
// Master/owner setup helper. Given a candidate ThinQ PAT + client
// id (typed in or already on the location), list the AC devices on
// the LG account so the operator can pick which ones map to which
// CRM device labels (e.g. "Bathroom M", "Bathroom F").
//
// If no PAT in the query, fall back to the active location's saved
// PAT — useful for "show me current devices" without re-pasting.
// Same fallback for client_id and country.
//
// Returns only DEVICE_AIR_CONDITIONER entries (filtered by
// listDevices itself). Other LG appliances on the account are
// silently dropped — the CRM has no use for them via this surface.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listDevices, ThinqError } from '@/lib/thinq'
import { overlayConnections } from '@/lib/connection-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'master' && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Master or owner only.' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  let pat         = searchParams.get('pat')
  let clientId    = searchParams.get('client_id')
  let countryCode = searchParams.get('country') || null

  // Fall back to saved location values for anything not in the query.
  if (!pat || !clientId) {
    const locationId = user.activeLocation?.id
    if (locationId) {
      const db = createServerClient()
      const { data: locRow } = await db
        .from('locations')
        .select('id, thinq_pat, thinq_client_id, thinq_country_code')
        .eq('id', locationId)
        .single()
      // INTEG-A2 dual-read: registry `thinq` row first.
      const loc = await overlayConnections(db, locRow, ['thinq'])
      pat         = pat         || loc?.thinq_pat         || null
      clientId    = clientId    || loc?.thinq_client_id   || null
      countryCode = countryCode || loc?.thinq_country_code || null
    }
  }
  countryCode = countryCode || 'IE'

  if (!pat) {
    return NextResponse.json(
      { success: false, error: 'No PAT supplied or saved on the active location.' },
      { status: 400 }
    )
  }
  if (!clientId) {
    return NextResponse.json(
      { success: false, error: 'No client_id supplied or saved on the active location. Generate one (uuid4) and save it alongside the PAT.' },
      { status: 400 }
    )
  }

  try {
    const devices = await listDevices({ pat, clientId, countryCode })
    return NextResponse.json({ success: true, data: devices })
  } catch (e) {
    const msg = e instanceof ThinqError ? e.message : (e?.message || String(e))
    // LG returns 401 for a bad PAT or revoked token. Pass that
    // through so the setup UI can show "your PAT looks wrong"
    // rather than a generic "vendor error".
    const status = e instanceof ThinqError && e.status === 401 ? 401 : 502
    return NextResponse.json({ success: false, error: msg, code: 'thinq_error' }, { status })
  }
}
