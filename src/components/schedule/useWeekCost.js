'use client'

// ROSTER-FIX.6c — the calendar's FTE weekly-hours slice.
//
// Deliberately its OWN hook rather than a seventh endpoint inside
// useScheduleData's Promise.all, for one reason: that fan-out is all-or-nothing
// by design (a rejection anywhere lands in `error` and, on a range change, can
// clear the blocks). The roster is the screen. A panel that summarises hours
// must not be able to take the roster down with it, so this fails SOFT — on a
// failure it reports no rows, the panel simply does not render, and the grid is
// untouched.
//
// It borrows useScheduleData's generation guard rather than rewriting it: a
// monotonic id stamps each request and only the newest one writes state, so
// clicking through weeks faster than the API answers cannot leave last week's
// hours under this week's dates.

import { useState, useEffect, useCallback, useRef } from 'react'

export function useWeekCost({ locationId, weekStart, enabled = true }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled || !locationId || !weekStart) {
      setData(null)
      return
    }
    const gen = ++generation.current
    try {
      const res = await fetch(
        `/api/schedule/week-cost?location_id=${locationId}&week_start=${weekStart}`
      )
      const body = await res.json().catch(() => null)
      if (gen !== generation.current) return
      if (!res.ok || !body?.success) {
        // Named, not swallowed - the caller can surface it if it ever wants to.
        setError(body?.error || `Request failed (${res.status})`)
        setData(null)
        return
      }
      setError(null)
      setData(body.data || null)
    } catch {
      if (gen !== generation.current) return
      setError('Network error')
      setData(null)
    }
  }, [locationId, weekStart, enabled])

  useEffect(() => { refresh() }, [refresh])

  return { weekCost: data, weekCostError: error, refreshWeekCost: refresh }
}
