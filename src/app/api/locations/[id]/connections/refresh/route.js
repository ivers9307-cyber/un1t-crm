// POST /api/locations/[id]/connections/refresh
//
// INTEG-A2 dual-write bridge. The integration settings tabs (Glofox /
// UniFi / Twilio / AC devices) save their legacy locations fields via
// the BROWSER Supabase client, but channel_connections is service-role
// write-only — so a tab save can't update the registry row itself and
// registry-first reads would go stale. The tabs fire-and-forget this
// endpoint after a successful save: it re-reads the location's CURRENT
// legacy fields server-side and re-syncs the active registry row per
// platform (upsert when legacy is configured, deactivate when legacy
// was cleared) using the exact mig 412 mapping.
//
// Scope: the dual-read platforms only (glofox, unifi, sensibo, thinq,
// twilio_sender, bca). WhatsApp / Instagram / Messenger / Xero are
// untouched — they have their own lifecycle routes.
//
// Auth: session + assertLocationAccess + ADMIN_ROLES at the location
// (mirrors /api/settings/ads). Idempotent — safe to call repeatedly.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { DUAL_READ_PLATFORMS, syncConnectionFromLegacy } from '@/lib/connection-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const role = user.isMaster ? 'master' : user.rolesByLocation?.[locationId]
  if (!ADMIN_ROLES.includes(role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, settings, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, thinq_country_code, twilio_alpha_sender_id, bca_config')
    .eq('id', locationId)
    .single()
  if (error || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  const results = {}
  for (const platform of DUAL_READ_PLATFORMS) {
    try {
      const { action } = await syncConnectionFromLegacy(db, locationId, platform, location)
      results[platform] = action
    } catch (e) {
      results[platform] = `error: ${e?.message || e}`
    }
  }

  return NextResponse.json({ success: true, data: { results } })
}
