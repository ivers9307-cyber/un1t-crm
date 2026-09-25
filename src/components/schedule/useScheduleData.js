'use client'

// ROSTER-FIX.6a — the schedule calendar's data layer, lifted out of
// ScheduleCalendar.jsx so the two defects it carried can be fixed and tested
// in one place.
//
// 1. NO ERROR HANDLING. fetchData awaited a bare Promise.all and then called
//    setLoading(false). Any rejection - the network dropping, a 500, an HTML
//    error page where JSON was expected - skipped that line, so the screen sat
//    on "Loading roster..." forever and the operator was told nothing. That is
//    the discarded-error defect class: the failure was real, it just never
//    reached a human. Now every failure lands in `error` for the caller to
//    render, and `loading` is cleared in a finally.
//
// 2. NO REQUEST ORDERING. Clicking the week arrow twice fires two fan-outs; if
//    the first answers last it repaints the week the operator has already left,
//    with no clue the dates on screen no longer match the data. A `generation`
//    counter now stamps each fan-out and only the newest one is allowed to
//    write state - a late loser is dropped whether it resolved or rejected.
//
// On failure the previously loaded week deliberately STAYS on screen (we only
// stop writing new values), so a flaky refresh shows a banner over real data
// rather than blanking a roster the operator was reading.
//
// ROSTER-FIX.6a-9 — but ONLY when it is still the same week. The header has
// already advanced by the time the fetch for the new range fails, so keeping
// the old blocks painted the PREVIOUS week's roster under the NEW week's
// dates. Sparse weeks then read as "nobody is rostered next week" and a
// manager acts on it. So: a failed refresh of the range on screen keeps its
// data (and the caller says it is stale); a failed load of a DIFFERENT range
// clears the range-scoped slices rather than mislabelling them.
//
// `showingStaleData` is what lets the banner say "showing the last data that
// loaded" only when there is in fact data being shown.
//
// ROSTERLOAD.1 — the fan-out above was ONE Promise.all, so ANY of the six
// reads failing failed the whole roster: a 500 from the approved-leave, bank-
// holiday or contractor-spend read put the stale banner over the week, or on
// a new week cleared the blocks and showed the manager an empty roster. Only
// the BLOCKS read decides whether the roster loaded now, with every rule above
// unchanged for it. The other five settle on their own (Promise.allSettled):
// a failed slice keeps its last value only while that value still belongs to
// what is on screen (its own scope key, below), is otherwise cleared, and is
// named in `partialErrors` so the screen can SAY it is missing. An empty leave
// slice that nobody mentions reads as "nobody is on leave", and a manager
// rosters over approved leave on the strength of it.
//
// A 401 / signed-out redirect on ANY read is not a degraded slice: the
// session is gone and the next action fails the same way. That is treated
// exactly like a failed blocks read.
//
// ROSTERLOAD.1 (review B1) — a 403 on a SIDE read is NOT fatal, and the first
// cut of this said it was. Contractor spend is manager-only (MANAGER_ROLES at
// the location) while `staff` and `reception` both reach this calendar, so
// every coach's load answered 403 on spend: on main that rejected the
// Promise.all and blanked the roster for every coach and reception user, and
// "403 is fatal" here kept it dead. A side read's 403 is a permission
// difference; LOST access shows as a 403 on BLOCKS (blocks, templates,
// time-off and holidays all run assertLocationAccess for the same location),
// and a failed blocks read is fatal whatever its status. And spend is not
// asked for at all by someone who cannot read it (`canReadSpend`).
//
// AVAIL.1 — a seventh read, `availability` (every active member's
// unavailability rules bearing on the range, GET /api/schedule/availability
// ?location_id=…). It is a side slice like spend and gated the same way: the
// route is MANAGER_ROLES at the studio, so it is asked for only with
// `canReadAvailability`, and a failed read is a named partial error. An
// empty availability slice nobody mentions reads as "every coach is free".

import { useState, useEffect, useCallback, useRef } from 'react'

// ROSTER-FIX.6a-8 — a dead session is not a server fault, and every schedule
// screen hits several endpoints at once, so an expired cookie showed up as a
// wall of "Request failed (401)" - which reads as "the roster is broken" and
// sends the operator to look for an outage. Say what actually happened.
//
// Deliberately NOT a redirect: the operator may have unpublished roster edits
// on screen and a silent bounce to /login throws them away. We name the state
// and let them choose when to reload.
export const SESSION_ENDED_MESSAGE =
  'You are signed out. Reload to sign in again.'

// ROSTER-FIX.6a-8 — 401 and 403 are NOT the same thing here. Every schedule
// route answers 403 through assertLocationAccess for a live session that may
// not read this location ("Forbidden - location not in your assignments"),
// and hasPermission returns its own 403 copy for a disabled feature. Folding
// those into the signed-out sentence sends an operator to re-authenticate over
// a permission they will still not have. Prefer the server's own words.
export const NO_ACCESS_MESSAGE =
  'You do not have access to this location. Switch location, or ask an owner for access.'

/**
 * Read a JSON endpoint, THROWING on anything that is not a success. Shared
 * with the schedule manager screens so "the request failed" is one shape
 * everywhere and cannot be forgotten at a call site.
 */
// ROSTERLOAD.1 — the error readJson throws carries the HTTP status it judged,
// so a caller can tell "this session/access is gone" (401, and a followed
// login redirect, both stamped 401; 403) from "this one read broke" without
// matching on words: a 403 keeps the SERVER's message, so its text cannot
// identify it. Existing callers only read `.message` and are unaffected.
function httpError(message, status) {
  const e = new Error(message)
  e.status = status
  return e
}

/**
 * True when a readJson failure means the session is gone (401, or a followed
 * login redirect / 200-non-JSON read, both stamped 401). A 403 is deliberately
 * NOT included: see the ROSTERLOAD.1 (review B1) note at the top.
 */
export function isSessionEnded(e) {
  return e?.status === 401
}

// ROSTERLOAD.1 (review S3) — a body of the wrong shape must fail its own
// slice, not throw out of the state writes with half of them applied (or,
// for blocks, reach the grid as a string and crash a `.filter`). A missing or
// null `data` stays an empty list, as it always was.
function listOf(res) {
  const data = res?.data
  if (data == null) return []
  if (!Array.isArray(data)) throw new Error('The server sent an answer this screen could not read.')
  return data
}

export async function readJson(url, options) {
  const res = await fetch(url, options)
  // A non-JSON body (an HTML 502 from the edge, say) must not throw a parse
  // error that reads like a bug - fall back to the status code.
  const data = await res.json().catch(() => null)
  if (res.status === 401) {
    throw httpError(SESSION_ENDED_MESSAGE, 401)
  }
  // CHANGELOG.1 — in production a signed-out request is not answered 401 at
  // all: src/proxy.js redirects it to /login, fetch follows, and the answer is
  // 200 + an HTML page. No schedule route ever redirects, so a followed
  // redirect IS a dead session. A 200 that is not JSON is the same thing seen
  // without the flag, but only on a READ: a mutation that answers 200 with an
  // empty body keeps meaning success, as it always has here.
  // Known edge: a GET that legitimately answers 204, or a literal JSON `null`,
  // would read as signed out here. No current caller does either.
  const isRead = !options?.method || String(options.method).toUpperCase() === 'GET'
  if (res.redirected || (isRead && res.ok && data === null)) {
    throw httpError(SESSION_ENDED_MESSAGE, 401)
  }
  if (res.status === 403) {
    throw httpError(data?.error || NO_ACCESS_MESSAGE, 403)
  }
  if (!res.ok || data?.success === false) {
    throw httpError(data?.error || `Request failed (${res.status})`, res.status)
  }
  return data || {}
}

// ROSTERLOAD.1 — the side slices (five, six with AVAIL.1) that no longer decide whether the roster
// loaded. `scope` is what a held value must still match to be kept after its
// read fails: the dates matter for leave, holidays and spend; templates and
// the coach list do not depend on the dates, but they do belong to a location.
// `apply` turns a successful body into the slice's value, as the old
// Promise.all branch did.
const SLICES = [
  { key: 'templates', scope: ({ locationId }) => locationId, apply: (res) => listOf(res).filter(t => t?.active) },
  { key: 'staff', scope: ({ locationId }) => locationId, apply: listOf },
  { key: 'timeOff', scope: ({ locationId, range }) => `${locationId}|${range}`, apply: listOf },
  { key: 'holidays', scope: ({ locationId, range }) => `${locationId}|${range}`, apply: listOf },
  {
    key: 'contractorSpend',
    // Spend answers for `spendReferenceDate`, but it is scoped to the range
    // too: ROSTER-FIX.6a-9 cleared it with the blocks on a new week, and a
    // spend figure held across weeks is the same mislabelling risk.
    scope: ({ locationId, range, spendReferenceDate }) => `${locationId}|${range}|${spendReferenceDate}`,
    apply: (res) => (res?.success ? res.data : null),
  },
  // AVAIL.1 — every active member's unavailability bearing on the range.
  // Manager-only (the route's gate), asked for only with canReadAvailability,
  // the way spend is asked for only with canReadSpend. A null (not asked)
  // applies as [] through listOf.
  { key: 'availability', scope: ({ locationId, range }) => `${locationId}|${range}`, apply: listOf },
]
const EMPTY = { templates: [], staff: [], timeOff: [], holidays: [], contractorSpend: null, availability: [] }

// `canReadSpend` — ROSTERLOAD.1 (review B1): whether the caller may read
// contractor spend at this location (the calendar passes its `isManager`, the
// same gate useWeekCost is `enabled` on). Without it spend resolves to null
// with NO request, and no partial error: nobody is told a figure they were
// never meant to see is missing. Defaults to false, the side that cannot
// fire a request the route will refuse.
//
// `canReadAvailability` — AVAIL.1: the same rule for the availability read.
export function useScheduleData({
  locationId, startDate, endDate, spendReferenceDate, canReadSpend = false, canReadAvailability = false,
}) {
  const [blocks, setBlocks] = useState([])
  const [templates, setTemplates] = useState([])
  const [staff, setStaff] = useState([])
  const [timeOff, setTimeOff] = useState([])
  const [holidays, setHolidays] = useState([])
  const [contractorSpend, setContractorSpend] = useState(null)
  const [availability, setAvailability] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showingStaleData, setShowingStaleData] = useState(false)
  // ROSTERLOAD.1 — `{ [slice]: { message, kept } }` for every non-blocks slice
  // whose read failed on the latest load, or null when none did. `kept` says
  // whether the slice still holds the value an earlier load gave it for the
  // same scope (true) or was cleared (false), so the screen can tell "could
  // not be refreshed" from "not available". Like `error`, it is NOT cleared at
  // the start of a refresh — only replaced when the next load settles — so a
  // note does not blink on every background refresh.
  const [partialErrors, setPartialErrors] = useState(null)
  // ROSTER-FIX.6a-13 — a monotonic count of loads that actually succeeded.
  // The calendar needs it to tell a REPEAT of a failure from a NEW one: an
  // identical message after a success is fresh information, and an identical
  // message after nothing is not. Only this hook knows which happened, so it
  // says, rather than leaving the component to infer it from `loading` edges.
  const [successCount, setSuccessCount] = useState(0)

  // The range the data currently in state was actually loaded for. Compared
  // against the range that just failed to decide keep-vs-clear.
  const loadedRange = useRef(null)
  // ROSTERLOAD.1 — the same idea, per non-blocks slice: the scope key each
  // slice's value in state was loaded for (null = nothing loaded / cleared).
  const loadedScope = useRef({})

  // Monotonic request id. Bumped before each fan-out; a response whose stamp
  // is no longer the current one is a loser and writes nothing.
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    const gen = ++generation.current
    // ROSTERLOAD.1 (review S1) — the location is part of the key. It was the
    // dates alone, and LocationSwitcher only calls router.refresh() (the
    // calendar is not re-keyed), so a failed blocks read after switching
    // studio in the same week kept studio A's blocks under studio B, while
    // the coach list and templates correctly moved to B.
    const requestedRange = `${locationId}|${startDate}..${endDate}`
    setLoading(true)
    // 🔴 THE ERROR IS NOT CLEARED HERE, and that is deliberate. It used to be,
    // and clearing it before the attempt is what made a persistent outage
    // BLINK: the banner unmounted at the start of every background refresh and
    // came back when the refresh failed. It also made ScheduleErrorBanner's
    // `busy` state dead UI — the banner renders 'Retrying…' and disables its
    // own button, and no operator could ever see it, because pressing Retry
    // unmounted the banner before the request left.
    //
    // A failed attempt stays true until a later one succeeds, so the error is
    // cleared on SUCCESS, below. The banner carries `busy={loading}` and says
    // what it is doing instead of vanishing.
    setShowingStaleData(false)
    const setters = {
      templates: setTemplates, staff: setStaff, timeOff: setTimeOff,
      holidays: setHolidays, contractorSpend: setContractorSpend,
      availability: setAvailability,
    }
    try {
      // ROSTERLOAD.1 — allSettled, not all: one read failing no longer throws
      // the others away. The order below is the SLICES order after blocks.
      const [blocksOutcome, ...sliceOutcomes] = await Promise.allSettled([
        readJson(`/api/schedule/blocks?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`),
        readJson(`/api/schedule/templates?location_id=${locationId}`),
        // ROSTER-FIX.6c — `?fields=picker`. Without it an admin caller's browser
        // received `*` (hourly_rate, annual_salary, overtime_rate) on every
        // calendar load, to render a coach dropdown and an hours panel. The
        // picker shape carries the names, the active flag, the role, the
        // location links and the contract hours the bars compare against.
        readJson('/api/staff?fields=picker'),
        readJson(`/api/schedule/time-off?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}&status=approved`),
        readJson(`/api/locations/${locationId}/holidays?start=${startDate}&end=${endDate}`),
        // ROSTERLOAD.1 (review B1) — no request a non-manager's session is
        // certain to be refused; `null` applies as "no spend figure".
        canReadSpend
          ? readJson(`/api/schedule/contractor-spend?location_id=${locationId}&reference_date=${spendReferenceDate}`)
          : Promise.resolve(null),
        // AVAIL.1 — likewise manager-only; `null` applies as "no rules".
        canReadAvailability
          ? readJson(`/api/schedule/availability?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`)
          : Promise.resolve(null),
      ])
      // allSettled never rejects, so this guard is now the ONLY one: a late
      // loser drops here for every slice, resolved or rejected.
      if (gen !== generation.current) return

      // ROSTERLOAD.1 (review S3) — turn every outcome into a value or a
      // failure BEFORE any state is written, so an `apply` that throws on a
      // malformed body fails its own slice instead of escaping half-applied.
      const judge = (outcome, apply) => {
        if (outcome.status === 'rejected') return { ok: false, reason: outcome.reason }
        try { return { ok: true, value: apply(outcome.value) } } catch (e) { return { ok: false, reason: e } }
      }
      const blocksResult = judge(blocksOutcome, listOf)
      const sliceResults = SLICES.map((slice, i) => judge(sliceOutcomes[i], slice.apply))

      // The roster failed to load if blocks failed (any status, including a
      // malformed body), or if a side read says the session is gone. A 403 on
      // a side read is a partial error: see the review B1 note at the top.
      const fatal = sliceResults.find(r => !r.ok && isSessionEnded(r.reason))
      const rosterFailure = !blocksResult.ok ? blocksResult.reason : fatal?.reason

      const ctx = { locationId, range: requestedRange, spendReferenceDate }
      const partial = {}
      SLICES.forEach((slice, i) => {
        const result = sliceResults[i]
        const scope = slice.scope(ctx)
        // A fatal load writes nothing new, for any slice: the same rule the
        // roster itself follows (keep what still belongs on screen).
        if (!fatal && result.ok) {
          setters[slice.key](result.value)
          loadedScope.current[slice.key] = scope
          return
        }
        const kept = loadedScope.current[slice.key] === scope
        if (!kept) {
          setters[slice.key](EMPTY[slice.key])
          loadedScope.current[slice.key] = null
        }
        // Only a slice's OWN failure is partial; under a fatal load the top-
        // level error already says everything.
        if (!fatal && !result.ok) {
          partial[slice.key] = { message: result.reason?.message || 'Could not load', kept }
        }
      })
      setPartialErrors(Object.keys(partial).length ? partial : null)

      if (rosterFailure) {
        failRoster(rosterFailure)
        return
      }

      setBlocks(blocksResult.value)
      loadedRange.current = requestedRange
      setError(null)
      setSuccessCount(n => n + 1)
    } catch (e) {
      // allSettled cannot reject and every `apply` is judged above, so this is
      // a backstop for a throw nobody predicted. It still takes the roster's
      // full failure path (stale-or-clear), never a half-way state.
      if (gen !== generation.current) return
      if (loadedRange.current !== requestedRange) {
        // As the old catch did for spend: whatever the range-scoped slices
        // hold may belong to another week, and nothing above got to judge.
        for (const key of ['timeOff', 'holidays', 'contractorSpend', 'availability']) {
          setters[key](EMPTY[key])
          loadedScope.current[key] = null
        }
      }
      failRoster(e)
    } finally {
      if (gen === generation.current) setLoading(false)
    }

    // The roster's failure path, unchanged from ROSTER-FIX.6a / 6a-9.
    function failRoster(reason) {
      setError(reason?.message || 'Could not load the roster')
      if (loadedRange.current === requestedRange) {
        // Same week, flaky refresh: the roster underneath is still true.
        setShowingStaleData(true)
      } else {
        // The dates on screen moved on. Whatever is held belongs to another
        // range, so showing it under these dates would be a lie the operator
        // has no way to spot. (Contractor spend, leave and holidays are
        // cleared by their own scope rule above.)
        setBlocks([])
        loadedRange.current = null
      }
    }
  }, [locationId, startDate, endDate, spendReferenceDate, canReadSpend, canReadAvailability])

  useEffect(() => { refresh() }, [refresh])

  return {
    blocks, templates, staff, timeOff, holidays, contractorSpend, availability,
    loading, error, showingStaleData, partialErrors, successCount, refresh,
  }
}
