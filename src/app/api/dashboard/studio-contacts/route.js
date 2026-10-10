// CONTACTREADSCOPE.1a — GET /api/dashboard/studio-contacts
//
// The Studio dashboard's contact numbers for ONE studio: new leads this week
// (joined_at since the Europe/Dublin Monday), the funnel by
// pipeline_stage_slug, and the contact total. The phone's Studio segment used
// to read them with its own session; from mig 690 that session reads a
// studio's contacts only while holding Contacts there, so a dashboard_studio
// holder without Contacts would have seen zeros. These are counts, not
// contact records: the gate is dashboard_studio AT location_id (the key the
// phone's Studio segment and the web Studio page use), after
// assertLocationAccess. Contacts is deliberately not required.
//
// Service role: the gate below is the only thing that matters here, so the
// client is created only after it passes. location_id is a query param, so a
// foreign studio is a 403 (the 404 rule is for detail routes whose id comes
// from the path).
//
// Query:   location_id  uuid (required)
// Returns: { success, data: { newLeadsThisWeek, funnel, totalContacts, membership_source } }
//          500 { success: false } when the read failed (never zeros).
//
// W1.M3c — `membership_source` (membershipStatePayload) rides alongside the
// counts: the funnel's later stages (first_class … converted) only move on
// membership and booking data, so at a studio whose source is not
// configured the phone puts a note under the funnel saying why. The counts
// themselves are contact counts and are never withheld. The state read is
// cached 60 s per location and never throws (a failed read is 'unknown').

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { dublinWeekStartMs } from '@/lib/dublin-time'
import { logError } from '@/lib/log'
import { fetchStudioContactCounts } from '@shared/dashboard-data'
import { membershipStateForPage, membershipStatePayload, canManageMembershipSource } from '@/lib/membership/state-for-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ location_id: uuidLike })

const READ_FAILED = 'Could not read the contact numbers'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ location_id: url.searchParams.get('location_id') })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, location_id, 'dashboard_studio')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const weekStartIso = new Date(dublinWeekStartMs(Date.now())).toISOString()
  const db = createServerClient()
  // Started alongside the counts; it never rejects (a failed read is
  // 'unknown'), and a rejection is caught to 'unknown' anyway so the key can
  // never 500 the counts for 2.3.x phones that never read it.
  const sourceStatePromise = membershipStateForPage(db, location_id)
    .catch(() => ({ source: null, state: 'unknown' }))
  let res
  try {
    res = await fetchStudioContactCounts(db, location_id, { weekStartIso })
  } catch (err) {
    res = { success: false, error: err?.message || String(err) }
  }
  const sourceState = await sourceStatePromise
  if (!res?.success) {
    logError('dashboard.studio-contacts', 'contact counts read failed', { locationId: location_id, error: res?.error })
    return NextResponse.json({ success: false, error: READ_FAILED }, { status: 500 })
  }
  return NextResponse.json({
    success: true,
    data: {
      ...res.data,
      membership_source: membershipStatePayload(sourceState, {
        canManage: canManageMembershipSource(user, location_id),
      }),
    },
  })
}
