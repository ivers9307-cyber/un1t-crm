// GET + PUT /api/locations/[id]/timezone — TZ.3 (SaaS timezone wave).
//
// The only writer of locations.timezone after creation. Mig 719 (TZ.2) took
// the client UPDATE away and validates the column by trigger
// (private.locations_timezone_guard, 22023), so this service-role route is
// how an owner changes a studio's zone.
//
// D2 = A (Richard, 11 Oct 2026): owners (and master) may change the zone AT
// ANY TIME. GET is the preflight: counts of what has future wall-clock meaning
// at the studio, judged in its CURRENT zone (src/lib/timezone-change.js). PUT
// needs the location's name typed back (confirm_name). There is no "future
// data" refusal and no master-only force path.
//
// What a change does, and does not do:
//   • wall-clock rows keep their LOCAL meaning (a 09:00 class stays 09:00, now
//     in the new zone); nothing is rewritten for that
//   • stored instants and calendar keys are NOT rewritten
//   • pending sequence steps are re-clamped by the next run-sequences pass
//   • unfinished WhatsApp broadcasts still on the OLD zone follow the new one
//     (they carry their own send_window_tz copy); a failure there is a
//     warning, never an undo of the change
//   • this instance's cached zone is dropped (resetLocationZoneCache); other
//     instances age out within the 60 s TTL
//   • one audit_events row names who, from, to and the counts
//
// Gate (Style B, the membership-source order): session → membership FIRST via
// assertLocationAccessOr404 (a detail route never confirms an id) → owner or
// master AT THE TARGET (guardMasterOrOwner judges rolesByLocation[id], never
// `user.role`) → body.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { canonicalZone, zoneOfLocation, resetLocationZoneCache } from '@/lib/location-time'
import { timezoneChangePreflight, followBroadcastZone } from '@/lib/timezone-change'
import { logAuditEvent } from '@/lib/audit'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIMEZONE_AUDIT_ACTION = 'location.timezone_changed'

const TimezoneChangeSchema = z.object({
  timezone: z.string().trim().max(64),
  // The location's name, typed by the owner: the confirm step.
  confirm_name: z.string().max(200),
})

// Session, membership (404), then owner-or-master at the target (403).
async function gate(props, verb) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { refusal: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return { refusal: access }
  if (guardMasterOrOwner(user, locationId)) {
    return {
      refusal: NextResponse.json({
        success: false,
        error: `Only owners and masters can ${verb} a location's timezone.`,
      }, { status: 403 }),
    }
  }
  return { user, locationId }
}

// `id` is the primary key, so maybeSingle() is structural.
async function readLocation(db, locationId) {
  const { data, error } = await db.from('locations').select('id, name, timezone').eq('id', locationId).maybeSingle()
  if (error) {
    logError('locations/timezone', 'location read failed', { locationId, err: error })
    return { response: NextResponse.json({ success: false, error: 'Could not read the location.' }, { status: 500 }) }
  }
  if (!data) return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  return { location: data }
}

export async function GET(_request, props) {
  const g = await gate(props, 'view the timezone change for')
  if (g.refusal) return g.refusal
  const db = createServerClient()
  const { location, response } = await readLocation(db, g.locationId)
  if (response) return response

  const pre = await timezoneChangePreflight(db, location)
  return NextResponse.json({
    success: true,
    data: {
      location: { id: location.id, name: location.name, timezone: pre.zone },
      today: pre.today,
      future: pre.future,
      unknown: pre.unknown,
      hasFutureData: pre.hasFutureData,
    },
  })
}

export async function PUT(request, props) {
  const g = await gate(props, 'change')
  if (g.refusal) return g.refusal
  const { user, locationId } = g

  const validation = await validateBody(request, TimezoneChangeSchema)
  if (!validation.ok) return validation.response
  const next = canonicalZone(validation.data.timezone)
  if (!next) {
    return NextResponse.json({
      success: false,
      code: 'invalid_timezone',
      error: 'Choose a real timezone, such as Europe/Dublin or America/New_York. Fixed offsets like +05:30 are not allowed.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { location, response } = await readLocation(db, locationId)
  if (response) return response

  const previous = zoneOfLocation(location)
  if (canonicalZone(previous) === next) {
    return NextResponse.json({ success: true, data: { timezone: next, previous, changed: false } })
  }

  if (validation.data.confirm_name.trim() !== String(location.name ?? '').trim()) {
    return NextResponse.json({
      success: false,
      code: 'confirm_mismatch',
      error: 'Type the location name exactly as it is shown to confirm the change.',
    }, { status: 400 })
  }

  // Counted in the OLD zone, before the write, for the audit and the response.
  const pre = await timezoneChangePreflight(db, location)

  const { data: touched, error: upErr } = await db
    .from('locations')
    .update({ timezone: next, updated_at: new Date().toISOString() })
    .eq('id', locationId)
    .select('id')
  if (upErr) {
    if (upErr.code === '22023') {
      return NextResponse.json({ success: false, code: 'invalid_timezone', error: upErr.message }, { status: 400 })
    }
    logError('locations/timezone', 'locations.timezone update failed', { locationId, next, err: upErr })
    return NextResponse.json({ success: false, error: 'Could not save the timezone. Try again.' }, { status: 500 })
  }
  if (!touched || touched.length === 0) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const broadcasts = await followBroadcastZone(db, locationId, previous, next)
  if (broadcasts.error) {
    logError('locations/timezone', 'drip broadcasts did not follow the new zone', { locationId, previous, next, err: broadcasts.error })
  }

  resetLocationZoneCache(locationId)

  const audit = await logAuditEvent({
    category: 'business',
    action: TIMEZONE_AUDIT_ACTION,
    actor: user ? { id: user.id, full_name: user.full_name, email: user.email } : null,
    // Not a profile: the identity rides in `resource` (logAuditEvent's contract).
    target: { resource: `location/${locationId}`, label: location.name || null },
    locationId,
    details: {
      from: previous,
      to: next,
      future: pre.future,
      unknown: pre.unknown,
      broadcasts: { followed: broadcasts.followed, kept: broadcasts.kept.length, error: broadcasts.error },
    },
    request,
  })
  if (!audit?.logged) {
    logWarn('locations/timezone', 'audit row not written', { locationId, from: previous, to: next, err: audit?.error || 'unknown' })
  }

  const body = {
    success: true,
    data: {
      timezone: next,
      previous,
      changed: true,
      future: pre.future,
      unknown: pre.unknown,
      broadcasts: { followed: broadcasts.followed, kept: broadcasts.kept },
    },
  }
  if (broadcasts.error) body.warning = 'broadcasts_not_followed'
  return NextResponse.json(body)
}
