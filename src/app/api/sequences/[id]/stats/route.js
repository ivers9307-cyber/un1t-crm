// GET /api/sequences/[id]/stats
//
// Tier 3A — per-step performance stats. Aggregates email_sends
// rows by sequence_step_id and surfaces:
//   - sent     (count of rows)
//   - opened   (count where opened_at IS NOT NULL)
//   - clicked  (count where clicked_at IS NOT NULL)
//   - bounced  (count where bounced_at IS NOT NULL)
//   - complained
//   - failed   (status='failed')
//
// Plus enrolment-level stats: total enrolled, currently active,
// completed, exited (with breakdown by exit_reason).
//
// SMS + WhatsApp stats are out of scope for v1 — those channels
// don't carry the same open/click signal that email does. The
// per-step "sent" count is still useful but operators get less
// from it.
//
// Manager+ at the sequence's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: seq, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (seqErr || !seq) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, seq.location_id)
  if (guard) return guard

  // Per-step email_sends rows. Pull the lot, aggregate client-side
  // — Supabase JS doesn't expose GROUP BY directly. Paginates via
  // selectAll (the old .limit(1000) PostgREST cap silently truncated a
  // busy sequence's stats); if this ever gets heavy, add a SQL view.
  let sends
  try {
    sends = await selectAll((from, to) => db
      .from('email_sends')
      .select('sequence_step_id, status, opened_at, clicked_at, bounced_at, complained_at')
      .eq('sequence_id', params.id)
      .order('id', { ascending: true })
      .range(from, to))
  } catch (sendsErr) {
    return NextResponse.json({ success: false, error: sendsErr.message }, { status: 500 })
  }

  const byStep = new Map()
  for (const s of (sends || [])) {
    const k = s.sequence_step_id
    if (!k) continue
    if (!byStep.has(k)) {
      byStep.set(k, { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, failed: 0 })
    }
    const agg = byStep.get(k)
    agg.sent += 1
    if (s.opened_at) agg.opened += 1
    if (s.clicked_at) agg.clicked += 1
    if (s.bounced_at) agg.bounced += 1
    if (s.complained_at) agg.complained += 1
    if (s.status === 'failed') agg.failed += 1
  }

  // Enrolment-level totals. Paginated via selectAll (the old
  // .limit(10_000) was silently capped at the 1000-row PostgREST
  // ceiling). Best-effort: an error here shouldn't fail the whole
  // stats response, so swallow it and report zeroes (matches the
  // prior un-checked behaviour).
  const enrolmentStats = { total: 0, active: 0, completed: 0, exited: 0, paused: 0 }
  const exitReasons = {}
  let enrolments = []
  try {
    enrolments = await selectAll((from, to) => db
      .from('sequence_enrollments')
      .select('status, exit_reason')
      .eq('sequence_id', params.id)
      .order('id', { ascending: true })
      .range(from, to))
  } catch {
    enrolments = []
  }
  for (const e of (enrolments || [])) {
    enrolmentStats.total += 1
    if (e.status === 'active') enrolmentStats.active += 1
    else if (e.status === 'completed') enrolmentStats.completed += 1
    else if (e.status === 'exited') {
      enrolmentStats.exited += 1
      const r = e.exit_reason || 'unspecified'
      exitReasons[r] = (exitReasons[r] || 0) + 1
    } else if (e.status === 'paused') enrolmentStats.paused += 1
  }

  return NextResponse.json({
    success: true,
    data: {
      enrolments: enrolmentStats,
      exit_reasons: exitReasons,
      per_step: Object.fromEntries(byStep),
    },
  })
}
