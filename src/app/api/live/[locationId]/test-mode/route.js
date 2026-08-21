// POST/DELETE /api/live/[locationId]/test-mode
//
// Staff HR test mode (mig 321): while active, a registered strap routes to its
// member's session any time (no live class). Time-boxed + self-expiring.
// POST body: { minutes?: number }  (default 120, clamped 1..240)
// Auth (SEC-LIVE-API.1): master / owner / manager / head_coach at the
// location, who ALSO hold `studio_management` there.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_MINUTES = 120
const MAX_MINUTES = 240

const Body = z.object({ minutes: z.number().int().positive().optional() })

function guard(user, locationId) {
  return guardLiveLocation(user, locationId, { roles: LIVE_MUTATION_ROLES })
}

export async function POST(request, props) {
  const { locationId } = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, locationId)
  if (denied) return denied

  const v = await validateBody(request, Body, { allowEmpty: true })
  if (!v.ok) return v.response
  const minutes = Math.min(MAX_MINUTES, Math.max(1, v.data?.minutes || DEFAULT_MINUTES))
  const until = new Date(Date.now() + minutes * 60_000).toISOString()

  const db = createServerClient()
  const { error } = await db.from('ble_bridges').update({ test_mode_until: until }).eq('location_id', locationId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  logInfo('live-test-mode', 'enabled', { locationId, minutes, by: user.id })
  return NextResponse.json({ ok: true, test_mode_until: until })
}

export async function DELETE(_request, props) {
  const { locationId } = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const { error } = await db.from('ble_bridges').update({ test_mode_until: null }).eq('location_id', locationId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, test_mode_until: null })
}
