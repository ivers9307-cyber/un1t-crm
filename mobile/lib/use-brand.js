// W1.B2 — useBrand(): the tenant brand for the screen's location.
//
// The hook side of mobile/lib/brand.js, kept in its own file (the
// use-is-tablet / use-physical-location precedent) so the loader stays a pure
// vitest module and this file is the only one that reaches the auth context.
//
//   useBrand()            → the staff session's active location (useAuth)
//   useBrand(locationId)  → an explicit location; member screens pass the
//                           contact's home studio (W1.S5 wires that), since a
//                           pure member session has no activeLocation.
//
// Returns the EMPTY brand until the load lands (empty strings and bare nouns,
// never a literal gym name — a screen renders nothing rather than the wrong
// gym), then the resolved one; a memory hit paints synchronously.

import { useEffect, useState } from 'react'
import { useAuth } from './auth-context'
import { EMPTY_BRAND, loadBrand, peekBrand } from './brand'

/**
 * @param {string|null} [locationId]  explicit location; defaults to the active staff location
 * @returns {{ companyName: string, shortName: string, logoUrl: string|null, productNames: { points: string, hr: string }, pointsUnit: string, loading: boolean }}
 */
export function useBrand(locationId) {
  const { activeLocation } = useAuth()
  const id = locationId || activeLocation?.id || null
  const [brand, setBrand] = useState(() => peekBrand(id) || EMPTY_BRAND)
  const [loading, setLoading] = useState(() => Boolean(id) && !peekBrand(id))

  useEffect(() => {
    let alive = true
    if (!id) {
      setBrand(EMPTY_BRAND)
      setLoading(false)
      return undefined
    }
    const hit = peekBrand(id)
    if (hit) {
      setBrand(hit)
      setLoading(false)
      return undefined
    }
    setLoading(true)
    loadBrand(id).then((b) => {
      if (!alive) return
      setBrand(b)
      setLoading(false)
    })
    return () => { alive = false }
  }, [id])

  return { ...brand, loading }
}
