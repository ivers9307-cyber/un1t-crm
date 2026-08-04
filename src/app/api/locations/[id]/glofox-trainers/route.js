// GET /api/locations/[id]/glofox-trainers
//
// STUDIO-KPI.2 — the trainer ids seen in this location's Glofox
// timetable (class_occurrences, last 28 days) and how each currently
// resolves to a display name: an operator override
// (settings.glofox.trainer_names), the Glofox API, or not at all.
// Powers the "Trainer names" reference list in the Glofox settings tab
// so the operator can see/copy the opaque ids Glofox sends — without
// it the override field is un-fillable (ids appear nowhere else in
// the UI; unresolved ids render as null instructors, not labels).
//
// Auth: master / owner / manager only (mirrors /glofox-memberships —
// both touch integration data).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { extractTrainerIds, resolveTrainerNames } from '@/lib/class-occurrences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])
const WINDOW_DAYS = 28

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      success: false, error: 'glofox_not_configured',
      message: 'Set Glofox credentials on this location first.',
    }, { status: 400 })
  }

  // 28d of Stillorgan is ~850 rows, under the 1000-row select cap; the
  // list is a distinct-id reference, so a truncated deep tail (order:
  // newest first) would only ever hide a trainer who hasn't taught in
  // weeks anyway.
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- deliberate cap: distinct-id reference list, newest-first; a truncated tail only hides trainers idle for weeks
  const { data: rows, error } = await db
    .from('class_occurrences')
    .select('trainers:raw->trainers')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .order('starts_at', { ascending: false })
    .limit(1000)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const ids = extractTrainerIds(rows || [])
  const classCount = new Map()
  for (const r of rows || []) {
    for (const id of extractTrainerIds([r])) {
      classCount.set(id, (classCount.get(id) || 0) + 1)
    }
  }

  const overrides = {}
  for (const [id, name] of Object.entries(creds.trainerNames || {})) {
    if (typeof name === 'string' && name.trim()) overrides[id.toLowerCase()] = name.trim()
  }
  const resolved = await resolveTrainerNames(creds, ids)

  const trainers = ids
    .map((id) => ({
      id,
      name: resolved[id] || null,
      source: overrides[id] ? 'override' : (resolved[id] ? 'glofox' : null),
      classes: classCount.get(id) || 0,
    }))
    .sort((a, b) => b.classes - a.classes)

  return NextResponse.json({ success: true, data: { trainers, windowDays: WINDOW_DAYS } })
}
