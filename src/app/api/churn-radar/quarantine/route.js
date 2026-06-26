// /api/churn-radar/quarantine
//
// CHURN-RADAR.1 — the quarantine surface for paying members with no
// activity footprint (the ~800 "ghost member" records).
//
//   GET  — list the untriaged quarantine records.
//   POST — bulk triage: { contact_ids: [...], decision: 'stale'|'keep' }
//          'stale' reclassifies the contact's pipeline stage to
//          dormant; both decisions log a churn_radar_actions row so
//          the record drops off the quarantine list.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadQuarantine } from '@/lib/churn-radar-data'
import { radarCache, invalidateRadar } from '@/lib/radar-cache'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'

const QuarantineTriageSchema = z.object({
  decision:    z.enum(['stale', 'keep']),
  contact_ids: z.array(z.string()).min(1),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BULK = 500

async function requireAccess() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(user, 'churn_radar')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }
  return { user, locationId }
}

export async function GET() {
  const access = await requireAccess()
  if (access.error) return access.error
  const db = createServerClient()
  try {
    const items = await radarCache(
      'churn', access.locationId, 'quarantine',
      () => loadQuarantine(db, access.locationId),
    )
    return NextResponse.json({ success: true, data: { items } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}

export async function POST(request) {
  const access = await requireAccess()
  if (access.error) return access.error
  const { user, locationId } = access

  const v = await validateBody(request, QuarantineTriageSchema)
  if (!v.ok) return v.response
  const { decision, contact_ids: rawIds } = v.data
  const contactIds = rawIds.filter(Boolean)
  if (contactIds.length === 0) {
    return NextResponse.json({ success: false, error: 'contact_ids is required' }, { status: 400 })
  }
  if (contactIds.length > MAX_BULK) {
    return NextResponse.json({ success: false, error: `Max ${MAX_BULK} contacts per request` }, { status: 413 })
  }

  const db = createServerClient()

  // Scope: only contacts that actually belong to the active location.
  const { data: scoped, error: scopeErr } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', locationId)
    .in('id', contactIds)
  if (scopeErr) {
    return NextResponse.json({ success: false, error: scopeErr.message }, { status: 500 })
  }
  const ids = (scoped || []).map((c) => c.id)
  if (ids.length === 0) {
    return NextResponse.json({ success: false, error: 'No contacts in scope' }, { status: 400 })
  }

  // 'stale' — reclassify the pipeline stage out of the active base.
  if (decision === 'stale') {
    const { error: updErr } = await db
      .from('contacts')
      .update({ pipeline_stage_slug: 'dormant' })
      .in('id', ids)
    if (updErr) {
      logWarn('churn-radar', 'quarantine reclassify failed', { err: updErr })
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }
  }

  const action = decision === 'stale' ? 'quarantine_stale' : 'quarantine_keep'
  const rows = ids.map((id) => ({
    contact_id: id,
    location_id: locationId,
    action,
    actor_id: user.id,
  }))
  const { error: logErr } = await db.from('churn_radar_actions').insert(rows)
  if (logErr) {
    logWarn('churn-radar', 'quarantine log insert failed', { err: logErr })
    return NextResponse.json({ success: false, error: logErr.message }, { status: 500 })
  }

  // Triage changes what the radar shows — drop the cached surfaces so
  // the next read (and the sidebar badge poll) reflects it immediately.
  invalidateRadar('churn', locationId)

  return NextResponse.json({ success: true, data: { triaged: ids.length, decision } })
}
