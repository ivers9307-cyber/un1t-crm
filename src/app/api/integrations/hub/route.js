// INTEG-B2 / INTEG-B4 — GET /api/integrations/hub. Owner+/master card
// states for the Integrations hub (/settings/integrations-hub).
//
// Assembles a location's connection state in one payload:
// channel_connections registry rows (with legacy fallback via the
// dual-read mappers), xero_connections, whatsapp_numbers (read-only),
// ad_accounts presence, the customer-agent live signal, and the
// INTEG-C4 billing strip (pinned plan + wallet + MTD meters; plan:
// null for every unpinned location — all of them today). Batched —
// one query per table, not per location. Secrets never leave the
// server: the assembler selects no token columns (see
// src/lib/integrations-hub.js).
//
// ACCESS (B4 rollout — the hub is now the primary integrations surface):
//   - master: EVERY real location (unchanged from phase B).
//   - owner / org-admin (SAAS-4): ONLY the locations of the org(s) they
//     own/administer — the payload is HARD-SCOPED to those via
//     getOwnerOrganizationIds(), so an owner never receives another
//     tenant's locations, statuses, tokens, or billing strip.
//   - manager / head_coach / staff: 403.
// The service-role client bypasses RLS, so the .in('organization_id')
// filter below IS the tenant boundary (same model as the org-scoped
// contract-templates / billing routes).

import { NextResponse } from 'next/server'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Columns the hub assembler needs off each location row. Host-anchor
// rows are synthetic event-host containers with no integrations — the
// same filter as the /settings index — so they're excluded.
const HUB_LOCATION_COLUMNS =
  'id, name, active, settings, features, sensibo_api_key, sensibo_pod_id, ' +
  'thinq_pat, thinq_client_id, thinq_country_code, twilio_alpha_sender_id, bca_config'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Owner+/master gate. Non-masters must own/administer at least one org
  // (getOwnerOrganizationIds includes SAAS-4 org admins); everyone else
  // — managers, head coaches, staff — gets 403.
  const ownerOrgIds = user.isMaster ? null : getOwnerOrganizationIds(user)
  if (!user.isMaster && ownerOrgIds.length === 0) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  let query = db
    .from('locations')
    .select(HUB_LOCATION_COLUMNS)
    .eq('is_host_anchor', false)
    .order('created_at')
  // Non-masters are constrained to their own organisation(s)' locations.
  // Scoping the `locations` query alone is sufficient: the assembler
  // fans every downstream table read out over exactly these location
  // ids (.in('location_id', ids)), so the whole payload inherits the
  // scope — no assembler change needed.
  if (!user.isMaster) query = query.in('organization_id', ownerOrgIds)

  const { data: locations, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const data = await assembleIntegrationsHub(db, locations || [])
  return NextResponse.json({ success: true, data })
}
