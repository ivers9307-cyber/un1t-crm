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
  'You are signed out or no longer have access to this location. Reload to sign in again.'

/**
 * Read a JSON endpoint, THROWING on anything that is not a success. Shared
 * with the schedule manager screens so "the request failed" is one shape
 * everywhere and cannot be forgotten at a call site.
 */
export async function readJson(url, options) {
  const res = await fetch(url, options)
  // A non-JSON body (an HTML 502 from the edge, say) must not throw a parse
  // error that reads like a bug - fall back to the status code.
  const data = await res.json().catch(() => null)
  if (res.status === 401 || res.status === 403) {
    throw new Error(SESSION_ENDED_MESSAGE)
  }
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
  return data || {}
}

export function useScheduleData({ locationId, startDate, endDate, spendReferenceDate }) {
  const [blocks, setBlocks] = useState([])
  const [templates, setTemplates] = useState([])
  const [staff, setStaff] = useState([])
  const [timeOff, setTimeOff] = useState([])
  const [holidays, setHolidays] = useState([])
  const [contractorSpend, setContractorSpend] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showingStaleData, setShowingStaleData] = useState(false)

  // The range the data currently in state was actually loaded for. Compared
  // against the range that just failed to decide keep-vs-clear.
  const loadedRange = useRef(null)

  // Monotonic request id. Bumped before each fan-out; a response whose stamp
  // is no longer the current one is a loser and writes nothing.
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    const gen = ++generation.current
    const requestedRange = `${startDate}..${endDate}`
    setLoading(true)
    setError(null)
    setShowingStaleData(false)
    try {
      const [blocksRes, templatesRes, staffRes, timeOffRes, holidaysRes, spendRes] = await Promise.all([
        readJson(`/api/schedule/blocks?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`),
        readJson(`/api/schedule/templates?location_id=${locationId}`),
        readJson('/api/staff'),
        readJson(`/api/schedule/time-off?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}&status=approved`),
        readJson(`/api/locations/${locationId}/holidays?start=${startDate}&end=${endDate}`),
        readJson(`/api/schedule/contractor-spend?location_id=${locationId}&reference_date=${spendReferenceDate}`),
      ])
      if (gen !== generation.current) return
      setBlocks(blocksRes.data || [])
      setTemplates((templatesRes.data || []).filter(t => t.active))
      setStaff(staffRes.data || [])
      setTimeOff(timeOffRes.data || [])
      setHolidays(holidaysRes.data || [])
      setContractorSpend(spendRes?.success ? spendRes.data : null)
      loadedRange.current = requestedRange
    } catch (e) {
      if (gen !== generation.current) return
      setError(e?.message || 'Could not load the roster')
      if (loadedRange.current === requestedRange) {
        // Same week, flaky refresh: the roster underneath is still true.
        setShowingStaleData(true)
      } else {
        // The dates on screen moved on. Whatever is held belongs to another
        // range, so showing it under these dates would be a lie the operator
        // has no way to spot.
        setBlocks([])
        setContractorSpend(null)
        loadedRange.current = null
      }
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [locationId, startDate, endDate, spendReferenceDate])

  useEffect(() => { refresh() }, [refresh])

  return { blocks, templates, staff, timeOff, holidays, contractorSpend, loading, error, showingStaleData, refresh }
}
