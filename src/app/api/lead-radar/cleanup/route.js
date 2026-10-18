// /api/lead-radar/cleanup
//
// LEAD-RADAR.1 — the cleanup surface for dormant non-member records
// (the ~6,600 lead/trial contacts that joined months-to-years ago
// and never booked or attended).
//
//   GET  — list untriaged cleanup records. Optional ?bucket=
//          (cooling | dormant | no_sale) filters; the response is
//          capped — see LIST_CAP — with the full filtered total.
//   POST — bulk triage: { contact_ids: [...], decision: 'archive'|'keep' }
//          'archive' reclassifies the contact's pipeline stage to
//          dormant (out of active pipeline + campaign-audience
//          scope); both decisions log a lead_radar_actions row so the
//          record drops off the cleanup list.
//
// Access: lead_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadCleanup } from '@/lib/lead-radar-data'
import { radarCache, invalidateRadar } from '@/lib/radar-cache'
import { radarAvailability, RADAR_UNAVAILABLE } from '@/lib/radar-availability'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { crossoverIdsAt } from '@/lib/contact-crossovers'
import { radarReadsFor } from '@/lib/membership/reads/index'

const CleanupBody = z.object({
  decision: z.enum(['archive', 'keep']),
  contact_ids: z.array(z.string()).min(1),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BULK = 500
// The cleanup base is huge (~6,600). Cap the list payload; the
// operator triages in pages, narrowing with the bucket filter.
const LIST_CAP = 500
const BUCKETS = ['cooling', 'dormant', 'no_sale']

async function requireAccess() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(user, 'lead_radar')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }
  return { user, locationId }
}

export async function GET(request) {
  const access = await requireAccess()
  if (access.error) return access.error

  const bucket = new URL(request.url).searchParams.get('bucket')
  const db = createServerClient()
  try {
    // UN1TRADAR.1 — before the cache: a source without membership data answers data:null
    const avail = await radarAvailability(db, access.locationId, { module: 'lead-radar' })
    if (!avail.available) return NextResponse.json(RADAR_UNAVAILABLE)
    const { cleanup, summary } = await radarCache(
      'lead', access.locationId, 'cleanup',
      () => loadCleanup(db, access.locationId),
    )
    const filtered = BUCKETS.includes(bucket)
      ? cleanup.filter((r) => r.bucket === bucket)
      : cleanup
    return NextResponse.json({
      success: true,
      data: { items: filtered.slice(0, LIST_CAP), total: filtered.length, summary },
      source: avail.source,
      dataAsOf: avail.dataAsOf,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}

export async function POST(request) {
  const access = await requireAccess()
  if (access.error) return access.error
  const { user, locationId } = access

  const validation = await validateBody(request, CleanupBody)
  if (!validation.ok) return validation.response
  const body = validation.data
  const decision = body.decision
  const contactIds = body.contact_ids.filter(Boolean)
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

  // 'archive' — reclassify the pipeline stage to dormant, moving the
  // record out of active pipeline + campaign-audience scope. Not a
  // delete: reversible, and the record is preserved for history.
  // UN1TRADAR.3 — at a studio whose membership source is not Glofox the
  // decision is logged only: contacts.pipeline_stage_slug follows the primary
  // board there, which spec A's classifier owns (Claude's call 6).
  const { source } = await radarReadsFor(db, locationId)
  if (decision === 'archive' && source === 'glofox' && ownedIds.length > 0) {
    const { error: updErr } = await db
      .from('contacts')
      .update({ pipeline_stage_slug: 'dormant' })
      .in('id', ownedIds) // owned only: a crossover's row is another studio's
    if (updErr) {
      logWarn('lead-radar', 'cleanup reclassify failed', { err: updErr })
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }
  }

  const action = decision === 'archive' ? 'cleanup_archive' : 'cleanup_keep'
  const rows = ids.map((id) => ({
    contact_id: id,
    location_id: locationId,
    action,
    actor_id: user.id,
  }))
  const { error: logErr } = await db.from('lead_radar_actions').insert(rows)
  if (logErr) {
    logWarn('lead-radar', 'cleanup log insert failed', { err: logErr })
    return NextResponse.json({ success: false, error: logErr.message }, { status: 500 })
  }

  // Triage changes what the radar shows — drop the cached surfaces so
  // the next read (and the sidebar badge poll) reflects it immediately.
  invalidateRadar('lead', locationId)

  return NextResponse.json({ success: true, data: { triaged: ids.length, decision } })
}
