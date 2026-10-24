// TRIALSTUDIO.2 — the studios the /trial page offers, and what each one sells.
// Stillorgan's memberships live in Glofox, Hatch Street's in un1t.online; each
// studio's landing row carries its own paid_trial block. loadTrialStudios is
// the one place that reads both, so the page and the routes agree on which
// studios are sellable.

import { paidTrialConfigFromBlocks } from '@/lib/paid-trial'
import { logWarn } from '@/lib/log'

export const TRIAL_STUDIOS = Object.freeze([
  Object.freeze({ key: 'stillorgan', publicPath: 'stillorgan' }),
  Object.freeze({ key: 'hatch', publicPath: 'hatch-street' }),
])

/** The studio entry for a key, exactly as typed ('HATCH' is not 'hatch'); null otherwise. */
export function studioByKey(key) {
  if (typeof key !== 'string') return null
  return TRIAL_STUDIOS.find((s) => s.key === key) || null
}

const embedded = (v) => (Array.isArray(v) ? v[0] : v) || null

/**
 * Every studio with its paid_trial block, location and, for a un1t.online
 * block, the mirrored product, plus the resolved config. A read error marks
 * the affected studio(s) not sellable rather than throwing: the page then
 * offers nothing to buy there instead of a guess. Those error-path entries
 * also carry `unreadable: true` (absent otherwise), so a caller can tell "we
 * could not read" (answer 503) from "nothing is for sale" (a refusal).
 * @returns {Promise<Array<{ key: string, publicPath: string, locationId: string|null,
 *   membershipSource: string|null, block: object|null, product: object|null,
 *   sellable: boolean, config: object|null, unreadable?: true }>>}
 */
export async function loadTrialStudios(db) {
  const empty = (s) => ({ key: s.key, publicPath: s.publicPath, locationId: null, membershipSource: null, block: null, product: null, sellable: false, config: null })
  const unreadableEntry = (s) => ({ ...empty(s), unreadable: true })

  const { data: pages, error } = await db
    .from('landing_page_settings')
    .select('location_id, public_path, blocks, locations:location_id ( membership_source )')
    .in('public_path', TRIAL_STUDIOS.map((s) => s.publicPath))
  if (error) {
    logWarn('trial-studios', 'landing rows unreadable', { paths: TRIAL_STUDIOS.map((s) => s.publicPath) })
    return TRIAL_STUDIOS.map(unreadableEntry)
  }
  const byPath = new Map((Array.isArray(pages) ? pages : []).map((p) => [p.public_path, p]))

  return Promise.all(TRIAL_STUDIOS.map(async (studio) => {
    const page = byPath.get(studio.publicPath)
    if (!page) return empty(studio)
    const locationId = page.location_id || null
    const membershipSource = embedded(page.locations)?.membership_source || null
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const block = blocks.find((x) => x && typeof x === 'object' && x.type === 'paid_trial') || null
    const base = { key: studio.key, publicPath: studio.publicPath, locationId, membershipSource, block, product: null }
    if (!block) return { ...base, sellable: false, config: null }

    const un1tId = typeof block.un1t_product_id === 'string' ? block.un1t_product_id.trim() : ''
    let product = null
    if (un1tId && locationId) {
      const { data, error: productErr } = await db
        .from('un1t_products')
        .select('un1t_id, status, price_cents, currency, title')
        .eq('location_id', locationId)
        .eq('un1t_id', un1tId)
        .maybeSingle()
      if (productErr) {
        logWarn('trial-studios', 'un1t product unreadable', { locationId, un1tId })
        return { ...base, sellable: false, config: null, unreadable: true }
      }
      product = data || null
    }
    const config = paidTrialConfigFromBlocks(blocks, studio.publicPath, { product })
    return { ...base, product, sellable: config !== null, config }
  }))
}
