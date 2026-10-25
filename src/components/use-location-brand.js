'use client'

// W1.S2 — useLocationBrand(locationId): the tenant brand for a STAFF client
// component that has a location in scope but no server page to hand it the
// resolved branding (the web twin of mobile/lib/use-brand.js).
//
// Reads /api/public/branding?location_id= (W1.B2 shape: company_name,
// short_name, product_names, points_unit). Until the load lands, and whenever
// it fails or there is no location, it answers the EMPTY brand — empty
// strings and bare nouns ("Points", "HR"), never a literal gym name — so a
// screen renders nothing rather than the wrong gym. One fetch per location
// per page load: answers are memoised per location id for the tab's life.

import { useEffect, useState } from 'react'
import { productName, pointsUnit } from '@/lib/brand-name'

export const EMPTY_BRAND = Object.freeze({
  companyName: '',
  shortName: '',
  logoUrl: null,
  productNames: Object.freeze({ points: productName('', 'points'), hr: productName('', 'hr') }),
  pointsUnit: pointsUnit(''),
})

const cache = new Map()

function shape(data) {
  const companyName = (data?.company_name || '').trim()
  const shortName = (data?.short_name || '').trim() || companyName
  return Object.freeze({
    companyName,
    shortName,
    logoUrl: data?.logo_url || null,
    productNames: Object.freeze({
      points: data?.product_names?.points || productName(shortName, 'points'),
      hr: data?.product_names?.hr || productName(shortName, 'hr'),
    }),
    pointsUnit: data?.points_unit || pointsUnit(shortName),
  })
}

/** Load (once per location) the brand for `locationId`; never throws. */
export async function loadLocationBrand(locationId) {
  if (!locationId) return EMPTY_BRAND
  if (cache.has(locationId)) return cache.get(locationId)
  const pending = (async () => {
    try {
      const res = await fetch(`/api/public/branding?location_id=${encodeURIComponent(locationId)}`)
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        cache.delete(locationId)
        return EMPTY_BRAND
      }
      const brand = shape(json.data)
      cache.set(locationId, brand)
      return brand
    } catch {
      cache.delete(locationId)
      return EMPTY_BRAND
    }
  })()
  cache.set(locationId, pending)
  return pending
}

/** Test seam: forget every cached answer. */
export function resetLocationBrandCache() {
  cache.clear()
}

/**
 * @param {string|null|undefined} locationId
 * @returns {{ companyName: string, shortName: string, logoUrl: string|null, productNames: { points: string, hr: string }, pointsUnit: string, loading: boolean }}
 */
export function useLocationBrand(locationId) {
  const hit = locationId ? cache.get(locationId) : null
  const [brand, setBrand] = useState(() => (hit && typeof hit.then !== 'function' ? hit : EMPTY_BRAND))
  const [loading, setLoading] = useState(() => Boolean(locationId) && !(hit && typeof hit.then !== 'function'))

  useEffect(() => {
    let alive = true
    if (!locationId) {
      setBrand(EMPTY_BRAND)
      setLoading(false)
      return undefined
    }
    const resolved = cache.get(locationId)
    if (resolved && typeof resolved.then !== 'function') {
      setBrand(resolved)
      setLoading(false)
      return undefined
    }
    setLoading(true)
    loadLocationBrand(locationId).then((b) => {
      if (!alive) return
      setBrand(b)
      setLoading(false)
    })
    return () => { alive = false }
  }, [locationId])

  return { ...brand, loading }
}
