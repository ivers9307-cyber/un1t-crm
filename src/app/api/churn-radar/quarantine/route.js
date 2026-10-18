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
import { radarAvailability, RADAR_UNAVAILABLE } from '@/lib/radar-availability'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { crossoverIdsAt } from '@/lib/contact-crossovers'
import { radarReadsFor } from '@/lib/membership/reads/index'

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
    // UN1TRADAR.1 — before the cache: a source without membership data answers data:null
    const avail = await radarAvailability(db, access.locationId, { module: 'churn-radar' })
    if (!avail.available) return NextResponse.json(RADAR_UNAVAILABLE)
    const items = await radarCache(
      'churn', access.locationId, 'quarantine',
      () => loadQuarantine(db, access.locationId),
    )
    return NextResponse.json({ success: true, data: { items }, source: avail.source, dataAsOf: avail.dataAsOf })
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
  const ownedIds = (scoped || []).map((c) => c.id)
  // UN1TRADAR.3 — plus crossovers AT the active studio (a membership or a
  // un1t client there). A failed probe adds none (owned contacts only).
  const owned = new Set(ownedIds)
  const crossover = await crossoverIdsAt(db, contactIds.filter((id) => !owned.has(id)), locationId)
  const ids = [...ownedIds, ...crossover]
  if (ids.length === 0) {
    return NextResponse.json({ success: false, error: 'No contacts in scope' }, { status: 400 })
  }

  // 'stale' — reclassify the pipeline stage out of the active base.
  // UN1TRADAR.3 — at a studio whose membership source is not Glofox the
  // decision is logged only: contacts.pipeline_stage_slug follows the primary
  // board there, which spec A's classifier owns (Claude's call 6).
  const { source } = await radarReadsFor(db, locationId)
  if (decision === 'stale' && source === 'glofox') {
    const { error: updErr } = await db
      .from('contacts')
      .update({ pipeline_stage_slug: 'dormant' })
      .in('id', ownedIds) // owned only: a crossover's row is another studio's
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
