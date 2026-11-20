// POST/DELETE /api/live/[locationId]/test-mode
//
// Staff HR test mode (mig 321): while active, a registered strap routes to its
// member's session any time (no live class). Time-boxed + self-expiring.
// POST body: { minutes?: number }  (default 120, clamped 1..240)
// Auth (SEC-LIVE-API.1): master / owner / manager / head_coach at the
// location, who ALSO hold `studio_management` there.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { guardLiveLocation, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { validateBody } from '@/lib/validate'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_MINUTES = 120
const MAX_MINUTES = 240

const Body = z.object({ minutes: z.number().int().positive().optional() })

function guard(user, locationId) {
  return guardLiveLocation(user, locationId, { roles: LIVE_MUTATION_ROLES })
}

const notSaved = (locationId, error) => {
  logError('live-test-mode', 'bridge update failed', { locationId, code: error?.code ?? null })
  return NextResponse.json({ ok: false, error: 'Could not change test mode. Try again.' }, { status: 500 })
}

// withAuth only signs the caller in; guard() judges the studio, the role and
// studio_management AT the URL's studio, as before (its 403s unchanged).
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const locationId = params?.locationId
  const denied = guard(user, locationId)
  if (denied) return denied

  const v = await validateBody(request, Body, { allowEmpty: true })
  if (!v.ok) return v.response
  const minutes = Math.min(MAX_MINUTES, Math.max(1, v.data?.minutes || DEFAULT_MINUTES))
  const until = new Date(Date.now() + minutes * 60_000).toISOString()

  const { error } = await db.from('ble_bridges').update({ test_mode_until: until }).eq('location_id', locationId)
  if (error) return notSaved(locationId, error)
  logInfo('live-test-mode', 'enabled', { locationId, minutes, by: user.id })
  return NextResponse.json({ ok: true, test_mode_until: until })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const locationId = params?.locationId
  const denied = guard(user, locationId)
  if (denied) return denied

  const { error } = await db.from('ble_bridges').update({ test_mode_until: null }).eq('location_id', locationId)
  if (error) return notSaved(locationId, error)
  return NextResponse.json({ ok: true, test_mode_until: null })
})
