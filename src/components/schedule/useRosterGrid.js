'use client'

// GRID.1 — the coach-by-day grid's read, as its own hook (like useWeekCost):
// the grid failing must never take the roster down, and a Days viewer must not
// pay for it. `enabled` is the calendar's showCoachGrid (manager, week view,
// Coaches); nothing is requested otherwise.
//
// Same request-ordering guard as useScheduleData: a monotonic generation stamps
// each request and only the newest writes state. The bump comes BEFORE the
// early return (the useWeekCost lesson), so disabling retires an in-flight
// request too.
//
// On failure: a refresh of the week already on screen KEEPS its grid (the
// component says it is the last one that loaded); a first load, or a load of a
// DIFFERENT week, shows no grid at all, never another week's rows under these
// dates. readJson (useScheduleData) gives the same signed-out and no-access
// words as the rest of the calendar.

import { useState, useEffect, useCallback, useRef } from 'react'
import { readJson } from './useScheduleData'

/**
 * window.localStorage, or null when there is no window or the browser refuses
 * it (merely touching the property throws a SecurityError when site data is
 * blocked). The layout preference helpers take this and never throw.
 */
export function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useRosterGrid({ locationId, weekStart, enabled = false }) {
  // GRID.1 review 2 — the grid and the failure are stored WITH the
  // `${locationId}|${weekStart}` they belong to, and handed back only while
  // that is still the studio and week asked for. Clearing them in the effect
  // was a frame too late: the first render after a week change still held last
  // week's grid, and the calendar built the new week's rows from it (everyone
  // 0h, every contract "to place", no flags: a false all-clear).
  const key = enabled && locationId && weekStart ? `${locationId}|${weekStart}` : null
  const [loaded, setLoaded] = useState({ key: null, data: null })
  const [failure, setFailure] = useState({ key: null, message: null })
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    if (!key) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const body = await readJson(`/api/schedule/grid?location_id=${locationId}&start_date=${weekStart}`)
      if (gen !== generation.current) return
      setLoaded({ key, data: body.data ?? null })
      setFailure({ key: null, message: null })
    } catch (e) {
      if (gen !== generation.current) return
      // A refresh of the week on screen keeps its grid (`loaded` is untouched,
      // and still matches); a first load of this week shows no grid at all.
      setFailure({ key, message: e?.message || 'Could not load the coach grid' })
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [key, locationId, weekStart])

  useEffect(() => { refresh() }, [refresh])

  const grid = key && loaded.key === key ? loaded.data : null
  const gridError = key && failure.key === key ? failure.message : null
  // Asked for, and neither answered nor failed yet: loading, from the very
  // first render with the new key (never "nothing to show" for a frame).
  const pending = Boolean(key) && loaded.key !== key && failure.key !== key
  return { grid, gridError, gridLoading: loading || pending, refreshGrid: refresh }
}
