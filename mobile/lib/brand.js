// W1.B2 — the phone's TENANT BRAND loader (not the colour tokens: those are
// mobile/lib/member/brand.js).
//
// company_settings is closed to client sessions (mig 674), so a phone can
// never read the brand from Supabase. /api/public/branding?location_id=
// resolves the W1.B1 chain (company_settings → org_settings → locations.name)
// on the service role and answers with the brand plus the product names
// ("{Brand} Points" / "{Brand} HR", built from the SHORT brand). This module
// caches that answer per location:
//
//   memory (per process)  →  AsyncStorage `brand:<locationId>`  →  network
//
// A cold start paints from storage and refreshes from the network behind it,
// so a renamed gym shows its new name on the second launch and the first
// launch never blocks on the link. A FAILED load is the EMPTY brand — empty
// strings and bare nouns, never a literal gym name — and is not cached, so
// the next caller asks again.
//
// Pure vitest module: its only edges are api() (mobile/lib/api.js, which
// keeps getSession() inside its own try — MOBILE-SESSION.1) and AsyncStorage,
// both stubbed in brand.test.js. The React hook is mobile/lib/use-brand.js,
// kept apart so this file never imports the auth context.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { productName, pointsUnit } from 'shared/brand-name'
import { api } from './api'

const STORAGE_PREFIX = 'brand:'

/** The brand nothing could resolve. Bare nouns match productName('', …). */
export const EMPTY_BRAND = Object.freeze({
  companyName: '',
  shortName: '',
  logoUrl: null,
  productNames: Object.freeze({ points: productName('', 'points'), hr: productName('', 'hr') }),
  pointsUnit: pointsUnit(''),
})

/** @param {string} locationId */
export function brandStorageKey(locationId) {
  return `${STORAGE_PREFIX}${locationId}`
}

/**
 * Shape the route's `data` into the brand the screens read. Derives the
 * product names from the short brand when the route omits them (a phone
 * ahead of its server), the same way the route builds them.
 * @param {object|null} data  /api/public/branding `data`
 * @returns {{ companyName: string, shortName: string, logoUrl: string|null, productNames: { points: string, hr: string }, pointsUnit: string }}
 */
export function brandFromApi(data) {
  if (!data || typeof data !== 'object') return EMPTY_BRAND
  const companyName = (data.company_name || '').trim()
  const shortName = (data.short_name || '').trim() || companyName
  const given = data.product_names && typeof data.product_names === 'object' ? data.product_names : {}
  return {
    companyName,
    shortName,
    logoUrl: data.logo_url || null,
    productNames: {
      points: given.points || productName(shortName, 'points'),
      hr: given.hr || productName(shortName, 'hr'),
    },
    pointsUnit: data.points_unit || pointsUnit(shortName),
  }
}

function isBrand(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.companyName === 'string'
}

// Per-process caches. `resolved` holds answers that came from the network or
// storage; `inFlight` dedupes concurrent callers (every screen on a tab asks
// at mount) into one request per location.
let resolved = new Map()
let inFlight = new Map()

/** Test seam: forget every cached brand. */
export function _resetBrandCache() {
  resolved = new Map()
  inFlight = new Map()
}

async function readStored(locationId) {
  try {
    const raw = await AsyncStorage.getItem(brandStorageKey(locationId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isBrand(parsed) ? brandFromApi({
      company_name: parsed.companyName,
      short_name: parsed.shortName,
      logo_url: parsed.logoUrl,
      product_names: parsed.productNames,
      points_unit: parsed.pointsUnit,
    }) : null
  } catch {
    // Storage is a convenience, never a dependency.
    return null
  }
}

async function writeStored(locationId, brand) {
  try {
    await AsyncStorage.setItem(brandStorageKey(locationId), JSON.stringify(brand))
  } catch {
    // Best-effort; the in-memory answer already serves this launch.
  }
}

/**
 * Fetch the brand from the route. Resolves to null on ANY failure — api()
 * answers a transport envelope rather than throwing on a dropped link, and
 * a server error is a `success: false` envelope — so a caller can tell "no
 * answer" from "an empty brand" (a location nobody has named yet).
 */
async function fetchBrand(locationId) {
  try {
    const res = await api(`/api/public/branding?location_id=${encodeURIComponent(locationId)}`)
    if (!res || !res.success || !res.data) return null
    return brandFromApi(res.data)
  } catch {
    return null
  }
}

/**
 * The brand for one location. Memory first; then the stored copy (with a
 * network refresh behind it); then the network. Never throws; never a
 * literal gym name.
 * @param {string|null|undefined} locationId
 * @returns {Promise<typeof EMPTY_BRAND>}
 */
export async function loadBrand(locationId) {
  if (!locationId) return EMPTY_BRAND
  const hit = resolved.get(locationId)
  if (hit) return hit
  const pending = inFlight.get(locationId)
  if (pending) return pending

  const task = (async () => {
    const stored = await readStored(locationId)
    if (stored) {
      resolved.set(locationId, stored)
      // Refresh behind the paint; a newer answer replaces the stored one for
      // the NEXT reader, and a failed refresh changes nothing.
      fetchBrand(locationId).then((fresh) => {
        if (fresh) {
          resolved.set(locationId, fresh)
          writeStored(locationId, fresh)
        }
      }).catch(() => {})
      return stored
    }
    const fresh = await fetchBrand(locationId)
    if (!fresh) return EMPTY_BRAND
    resolved.set(locationId, fresh)
    await writeStored(locationId, fresh)
    return fresh
  })()

  inFlight.set(locationId, task)
  try {
    return await task
  } finally {
    inFlight.delete(locationId)
  }
}

/** The brand already in memory for a location, or null — synchronous, for a first paint. */
export function peekBrand(locationId) {
  return (locationId && resolved.get(locationId)) || null
}
