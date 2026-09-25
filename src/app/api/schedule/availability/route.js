// src/app/api/schedule/availability/route.js
//
// AVAIL.1 — coach availability (mig 630). A coach says when they CANNOT
// work; no approval; the roster builders at every studio they belong to are
// told once per save (src/lib/availability-notify.js).
//
//   GET                                            the caller's own { weekly, dated }
//   GET ?location_id=&start_date=&end_date=        every active member's rules at that
//                                                  studio bearing on the range (manager)
//   PUT { weekly: [...], dated: [...] }            replace the caller's own
//
// Service-role route: mig 630's tables have no RLS policy and no browser
// grant, so THIS FILE is the whole access boundary. Own reads and writes are
// pinned to user.id (there is no profile_id parameter); the studio read runs
// assertLocationAccess and then a manager role AT that studio
// (SCHEDROLES.1: never user.role, the ACTIVE studio's). Cookie or Bearer
// (getCurrentUser), so the phone (AVAIL.2) uses this route as-is.

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike, isRealCalendarDate } from '@/lib/schemas'
import { dublinTodayStr, addDaysISO } from '@/lib/dublin-time'
import {
  AvailabilityPutSchema, AVAILABILITY_RANGE_MAX_DAYS, readOwnAvailability, saveOwnAvailability,
  readStudioAvailability, isAvailabilityInputError, readKnownDatedKeys,
} from '@/lib/availability-server'
import { normaliseAvailability, availabilityProblems, splitRules, withoutEnded } from '@shared/availability'
import { deliverOwedAvailabilityNotices } from '@/lib/availability-notify'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bad = (error, status = 400) => NextResponse.json({ success: false, error }, { status })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return bad('Unauthorized', 401)

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const db = createServerClient()

  if (!locationId) {
    const { data, error } = await readOwnAvailability(db, user.id, dublinTodayStr())
    if (error) {
      logError('api/schedule/availability', 'own read failed', { err: error.message })
      return bad('Could not load your availability', 500)
    }
    return NextResponse.json({ success: true, data })
  }

  if (!uuidLike.safeParse(locationId).success) return bad('location_id: must be a UUID')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return bad('Forbidden — needs a manager role at that location', 403)

  const startDate = url.searchParams.get('start_date')
  const endDate = url.searchParams.get('end_date')
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (!isRealCalendarDate(value)) return bad(`${name}: not a real date (YYYY-MM-DD)`)
  }
  if (endDate < startDate) return bad('end_date must be on or after start_date')
  if (endDate > addDaysISO(startDate, AVAILABILITY_RANGE_MAX_DAYS - 1)) {
    return bad(`The range is limited to ${AVAILABILITY_RANGE_MAX_DAYS} days`)
  }

  const { data, error } = await readStudioAvailability(db, { locationId, startDate, endDate })
  if (error) {
    logError('api/schedule/availability', 'studio read failed', { location_id: locationId, err: error.message })
    return bad('Could not load availability', 500)
  }
  return NextResponse.json({ success: true, data })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return bad('Unauthorized', 401)

  const v = await validateBody(request, AvailabilityPutSchema)
  if (!v.ok) return v.response

  const todayIso = dublinTodayStr()
  const input = normaliseAvailability(v.data)
  const db = createServerClient()

  // Dated rules that start before today are judged against what is STORED:
  // an ended one the coach already has is history sent back by a tab left
  // open over midnight (no problem; dropped below), a new one is refused.
  // Dates are validated YYYY-MM-DD, so a string compare orders them.
  const startedDates = [...new Set(input.dated.filter((r) => r.start_date < todayIso).map((r) => r.start_date))]
  const { keys: knownKeys, error: knownError } = startedDates.length
    ? await readKnownDatedKeys(db, user.id, todayIso, startedDates)
    : { keys: new Set(), error: null }
  if (knownError) {
    logError('api/schedule/availability', 'history read failed', { err: knownError.message })
    return bad('Could not save your availability', 500)
  }

  const issues = availabilityProblems(input, { todayIso, knownKeys })
  if (issues.length) {
    return NextResponse.json({ success: false, error: 'Invalid availability', issues }, { status: 400 })
  }
  const toSave = withoutEnded(input, todayIso)

  const { result, error } = await saveOwnAvailability(db, {
    profileId: user.id,
    // View as user: the person is the one being viewed; the master did it.
    actorId: user.impersonatingFrom?.masterId || user.id,
    todayIso,
    weekly: toSave.weekly,
    dated: toSave.dated,
  })
  if (error) {
    if (isAvailabilityInputError(error)) {
      // The RPC's own 'availability_<reason>: words' carries words meant for
      // the caller; a CHECK or cast failure carries Postgres internals
      // (constraint names), which stay in the log.
      const own = String(error.message || '').match(/^availability_\w+:\s*(.+)$/)
      if (!own) logWarn('api/schedule/availability', 'save refused by the database', { err: error.message, code: error.code })
      return bad(own ? own[1] : 'Invalid availability')
    }
    logError('api/schedule/availability', 'save failed', { err: error.message, code: error.code })
    return bad('Could not save your availability', 500)
  }

  if (result.changed && result.changeId) {
    // after(): an un-awaited promise past the response is the shape Vercel can
    // freeze mid-flight (SWAPNOTIFY.1). It tells the managers about THIS save
    // folded together with any older change of this coach still owed (so they
    // never get the newest state first and a stale one after). It never
    // throws, and anything it does not settle the checklist-sweep arm picks up
    // once the 10-minute lease has run out (src/lib/availability-notify.js).
    after(() => deliverOwedAvailabilityNotices(db, user.id))
  }

  return NextResponse.json({ success: true, data: { changed: result.changed, ...splitRules(result.after) } })
}
