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
  const [grid, setGrid] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  // The `${locationId}|${weekStart}` the grid in state was loaded for.
  const loadedKey = useRef(null)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    if (!enabled || !locationId || !weekStart) {
      setLoading(false)
      return
    }
    const key = `${locationId}|${weekStart}`
    if (loadedKey.current !== key) {
      // Another studio or week is in state: never show it under these dates.
      setGrid(null)
      loadedKey.current = null
    }
    setLoading(true)
    try {
      const body = await readJson(`/api/schedule/grid?location_id=${locationId}&start_date=${weekStart}`)
      if (gen !== generation.current) return
      setGrid(body.data ?? null)
      loadedKey.current = key
      setError(null)
    } catch (e) {
      if (gen !== generation.current) return
      setError(e?.message || 'Could not load the coach grid')
      if (loadedKey.current !== key) setGrid(null)
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [locationId, weekStart, enabled])

  useEffect(() => { refresh() }, [refresh])

  return { grid, gridError: error, gridLoading: loading, refreshGrid: refresh }
}
