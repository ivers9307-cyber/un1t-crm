// INTEG-B2 — GET /api/integrations/hub. Master-only card states for the
// Integrations hub (/settings/integrations-hub).
//
// Assembles every location's connection state in one payload:
// channel_connections registry rows (with legacy fallback via the
// dual-read mappers), xero_connections, whatsapp_numbers (read-only),
// ad_accounts presence, the customer-agent live signal, and the
// INTEG-C4 billing strip (pinned plan + wallet + MTD meters; plan:
// null for every unpinned location — all of them today). Batched —
// one query per table, not per location. Secrets never leave the
// server: the assembler selects no token columns (see
// src/lib/integrations-hub.js).
//
// MASTER-ONLY (rollout flag for phase B): the hub ships dark for
// owners/staff — they keep the per-location Integrations tabs, which
// this route and page do not touch. B4 does the swap.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  // profileRole (not the active-location role) — same gate as the other
  // master-only admin surfaces (/admin/integrations, /settings/impersonate).
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  // Master sees every real location. Host-anchor rows are synthetic
  // containers for third-party event hosts — no integrations live there
  // (same filter as the /settings index).
  const { data: locations, error } = await db
    .from('locations')
    .select('id, name, active, settings, features, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, thinq_country_code, twilio_alpha_sender_id, bca_config')
    .eq('is_host_anchor', false)
    .order('created_at')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const data = await assembleIntegrationsHub(db, locations || [])
  return NextResponse.json({ success: true, data })
}
