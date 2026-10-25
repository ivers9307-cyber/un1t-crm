'use client'

// ROSTERVIS.1 — the draft rosters at this location, for the calendar's
// publication chip.
//
// Why a fetch at all: a draft roster (a manager's over-budget publish waiting
// on an owner) does NOT tag shift_blocks — only a publish or an approval
// re-tags them — so the blocks feed cannot say "this week is awaiting
// approval". GET /api/schedule/rosters?status=draft can.
//
// Its own hook, not a slice of useScheduleData's all-or-nothing fan-out, for
// the reason useWeekCost gives: a status chip must not be able to take the
// roster down with it. It fails SOFT — on any failure it reports no drafts,
// and the chip falls back to what the blocks alone say.

import { useState, useEffect, useCallback, useRef } from 'react'

export function useDraftRosters({ locationId, enabled = true }) {
  const [drafts, setDrafts] = useState([])
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    // Bump before the early return, so a request in flight when the location
    // clears cannot land afterwards (see useWeekCost).
    const gen = ++generation.current
    if (!enabled || !locationId) {
      setDrafts([])
      return
    }
    try {
      const res = await fetch(`/api/schedule/rosters?location_id=${locationId}&status=draft`)
      const body = await res.json().catch(() => null)
      if (gen !== generation.current) return
      setDrafts(res.ok && body?.success && Array.isArray(body.data) ? body.data : [])
    } catch {
      if (gen !== generation.current) return
      setDrafts([])
    }
  }, [locationId, enabled])

  useEffect(() => { refresh() }, [refresh])

  return { draftRosters: drafts, refreshDraftRosters: refresh }
}
