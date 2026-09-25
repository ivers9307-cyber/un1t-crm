'use client'
// REPLACE.1b — the manager's open "Offer to team" offers for the visible
// period, keyed by shift. Only the newest load writes (a slow answer for a
// period just left cannot paint over the current one); a failed reload keeps
// what is there and says so. Disabled (a coach) = never asks.
import { useCallback, useEffect, useRef, useState } from 'react'
import { indexOffersByBlock } from '@shared/offer-to-team'

export function useShiftOffers({ locationId, startDate, endDate, enabled }) {
  const [byBlockId, setByBlockId] = useState({})
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++seq.current
    if (!enabled || !locationId || !startDate || !endDate) { setByBlockId({}); setFailed(false); return }
    const qs = new URLSearchParams({ location_id: locationId, view: 'manage', start_date: startDate, end_date: endDate })
    try {
      const res = await fetch(`/api/schedule/offers?${qs}`)
      const json = await res.json().catch(() => ({}))
      if (mine !== seq.current) return
      if (!res.ok || json.success !== true) { setFailed(true); return }
      setFailed(false)
      setByBlockId(indexOffersByBlock(json.data))
    } catch {
      if (mine === seq.current) setFailed(true)
    }
  }, [enabled, locationId, startDate, endDate])
  useEffect(() => { reload() }, [reload])
  return { byBlockId, failed, reload }
}
