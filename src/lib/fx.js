// FX rate fetcher — single source of truth for the live GBP→EUR
// number used in car profit calcs.
//
// Source: Frankfurter (api.frankfurter.app), which serves European
// Central Bank reference rates. Free, no API key, ECB-backed
// (i.e. authoritative). Bank rates may differ from this for actual
// purchases — operators can still override per-car if needed (the
// fx_gbp_to_eur column on cars stays in the schema for that).
//
// Cached for 24 hours via Next.js's revalidate hint AND wrapped in
// unstable_cache so concurrent requests resolve to the same value
// until expiry. Effectively one upstream fetch per day per region.

import { unstable_cache } from 'next/cache'

const SOURCE_URL = 'https://api.frankfurter.app/latest?from=GBP&to=EUR'
const ONE_DAY = 60 * 60 * 24

async function fetchGbpToEur() {
  try {
    const res = await fetch(SOURCE_URL, {
      // Per-request cache hint. Combined with unstable_cache below
      // this gives belt-and-braces 24h behaviour.
      next: { revalidate: ONE_DAY },
    })
    if (!res.ok) return null
    const json = await res.json()
    const rate = json?.rates?.EUR
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
    return rate
  } catch {
    return null
  }
}

// Wrapped cache — call this from server components / route handlers.
// Returns `{ rate, fetched_at, source }`. `rate` is null if the
// upstream is down (caller falls back to DEFAULT_GBP_TO_EUR).
export const getCachedGbpToEur = unstable_cache(
  async () => {
    const rate = await fetchGbpToEur()
    return {
      rate,
      fetched_at: new Date().toISOString(),
      source: rate ? 'frankfurter.app (ECB)' : 'unavailable',
    }
  },
  ['fx-gbp-to-eur'],
  { revalidate: ONE_DAY, tags: ['fx-rate'] }
)
