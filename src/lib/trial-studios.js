// TRIALSTUDIO.2 — the studios the /trial page offers, and what each one sells.
// Stillorgan's memberships live in Glofox, Hatch Street's in un1t.online; each
// studio's row on the `trial` page (PAGES.1: landing_page_studios) carries its
// own half of the paid_trial offer. loadTrialStudios is the one place that
// reads both, so the page and the routes agree on which studios are sellable.

import { paidTrialConfigFromBlocks, paidTrialAccountEmailCopy } from '@/lib/paid-trial'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import {
  loadPageBySlug, mergedBlocksFor, studioPublicPath, studioAttribution, studioPageBlocksFor, isPageVisible,
} from '@/lib/landing-pages'
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

// The page whose studio rows are the paid trial's studios (the /trial page).
const TRIAL_PAGE_SLUG = 'trial'

/**
 * Every studio with its paid_trial block, location and, for a un1t.online
 * block, the mirrored product, plus the resolved config. The studios are the
 * ENABLED rows of the live `trial` page (sort order), each keyed by its public
 * path (TRIAL_STUDIOS keys for the known ones) with the page's paid_trial block
 * merged with the row's offer and attribution (the row's tag and lead source
 * over the defaults, as the page form reads them). The result always carries
 * every TRIAL_STUDIOS key, in that order first (a studio the page does not
 * offer is `empty`, not sellable), then any other enabled row. A read error
 * marks the affected studio(s) not sellable rather than throwing: the page
 * then offers nothing to buy there instead of a guess. Those error-path
 * entries also carry `unreadable: true` (absent otherwise), so a caller can
 * tell "we could not read" (answer 503) from "nothing is for sale" (a
 * refusal). A un1t.online studio whose `settings.un1t_online.writes_enabled`
 * is off is not sellable (TRIALSTUDIO.10): the page says "not available
 * online" while the switch is off, as the POST's not_configured does.
 * @returns {Promise<Array<{ key: string, publicPath: string, locationId: string|null,
 *   membershipSource: string|null, block: object|null, product: object|null,
 *   sellable: boolean, config: object|null, unreadable?: true }>>}
 */
export async function loadTrialStudios(db) {
  const empty = (s) => ({ key: s.key, publicPath: s.publicPath, locationId: null, membershipSource: null, block: null, product: null, sellable: false, config: null })
  const unreadableEntry = (s) => ({ ...empty(s), unreadable: true })

  let entries = []
  try {
    const loaded = await loadPageBySlug(db, { orgId: UN1T_GROUP_ORG_ID, slug: TRIAL_PAGE_SLUG })
    // Only a live page takes a customer (a draft or retired trial page sells nothing).
    if (loaded && isPageVisible(loaded.page.publish_state)) {
      const { page, studios } = loaded
      const rows = studios.filter((r) => r.enabled).sort((a, b) => a.sort_order - b.sort_order)
      entries = (await Promise.all(rows.map(async (row) => {
        const publicPath = await studioPublicPath(db, row.location_id)
        // No studio page, no public path: no terms page and no way back from a checkout.
        if (!publicPath) return null
        const block = mergedBlocksFor({ page, studio: row }).find((x) => x && typeof x === 'object' && x.type === 'paid_trial') || null
        const mergedBlock = block ? { ...block, ...studioAttribution({ page, studioRow: row, publicPath }) } : null
        return trialEntryFromRow(db, { row, publicPath, mergedBlock })
      }))).filter(Boolean)
    }
  } catch (err) {
    logWarn('trial-studios', 'trial page unreadable', { slug: TRIAL_PAGE_SLUG, code: err?.cause?.code ?? err?.code ?? null })
    return TRIAL_STUDIOS.map(unreadableEntry)
  }
  const known = TRIAL_STUDIOS.map((s) => entries.find((e) => e.publicPath === s.publicPath) || empty(s))
  const extra = entries.filter((e) => !TRIAL_STUDIOS.some((s) => s.publicPath === e.publicPath))
  return [...known, ...extra]
}

/**
 * PAGES.1 — one studio's `loadTrialStudios` entry from a row that carries
 * `location_id` and the `locations:location_id ( membership_source, settings )`
 * embed (a landing_page_studios row) and the
 * studio's paid_trial block (for a page row: the page half merged with the
 * studio's offer, `mergedBlocksFor`). The key is the TRIAL_STUDIOS key for a
 * known public path, else the path itself. Same rules and same never-throw
 * contract as loadTrialStudios: a un1t.online studio with its writes off is
 * not sellable; a failed product read is not sellable and `unreadable`.
 */
export async function trialEntryFromRow(db, { row, publicPath, mergedBlock }) {
  const key = TRIAL_STUDIOS.find((s) => s.publicPath === publicPath)?.key || publicPath || null
  const locationId = row?.location_id || null
  const loc = embedded(row?.locations)
  const membershipSource = loc?.membership_source || null
  // Only the switch leaves this function, never the settings object.
  const writesEnabled = un1tWriteSettingsFrom(loc?.settings).writesEnabled
  const block = mergedBlock && typeof mergedBlock === 'object' && mergedBlock.type === 'paid_trial' ? mergedBlock : null
  const base = { key, publicPath, locationId, membershipSource, block, product: null }
  if (!block) return { ...base, sellable: false, config: null }
  // A un1t.online studio with its writes off has no account or checkout to
  // make: nothing is for sale (the POST answers not_configured), not unreadable.
  if (membershipSource === 'un1t_online' && !writesEnabled) return { ...base, sellable: false, config: null }

  const un1tId = typeof block.un1t_product_id === 'string' ? block.un1t_product_id.trim() : ''
  let product = null
  if (un1tId && locationId) {
    const { data, error: productErr } = await db
      .from('un1t_products')
      .select('un1t_id, status, type, price_cents, currency, title')
      .eq('location_id', locationId)
      .eq('un1t_id', un1tId)
      .maybeSingle()
    if (productErr) {
      logWarn('trial-studios', 'un1t product unreadable', { locationId, un1tId })
      return { ...base, sellable: false, config: null, unreadable: true }
    }
    product = data || null
  }
  const config = paidTrialConfigFromBlocks([block], publicPath, { product })
  return { ...base, product, sellable: config !== null, config }
}

/**
 * Final-review F2 — the account explanation email copy of the studio at
 * `locationId` (its studio page's paid_trial block, merged with its studio
 * row: account_email_subject / _body), for the Hatch Street settle sweep.
 * Never throws: an unreadable page, or a studio with no block, answers the
 * defaults (logged with ids only), which are the trial buyer's words, never
 * the class funnel's.
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function readPaidTrialAccountEmailCopy(db, locationId) {
  try {
    const { blocks } = await studioPageBlocksFor(db, locationId)
    return paidTrialAccountEmailCopy(blocks)
  } catch (err) {
    logWarn('trial-studios', 'paid_trial email copy unreadable; the defaults are used', { locationId, code: err?.cause?.code ?? err?.code ?? null })
    return paidTrialAccountEmailCopy(null)
  }
}

// TRIALSTUDIO.11 — where /start and /start/<studio> now send people: /trial with
// the studio preselected and the ad query (utm_*, fbclid, anything) carried
// over in its original order. `searchParams` is a URLSearchParams or the plain
// object Next hands a page (an array value repeats its key). An incoming
// `studio` is dropped so the path's studio wins.
const TRIAL_STUDIO_BY_PUBLIC_PATH = Object.freeze({ 'hatch-street': 'hatch', stillorgan: 'stillorgan' })

export function trialRedirectFor(publicPath, searchParams) {
  const incoming = new URLSearchParams()
  if (searchParams instanceof URLSearchParams) {
    for (const [k, v] of searchParams) incoming.append(k, v)
  } else if (searchParams && typeof searchParams === 'object') {
    for (const [k, v] of Object.entries(searchParams)) {
      if (Array.isArray(v)) v.forEach((item) => incoming.append(k, item))
      else if (v !== undefined && v !== null) incoming.append(k, v)
    }
  }
  incoming.delete('studio')
  const out = new URLSearchParams()
  const studio = TRIAL_STUDIO_BY_PUBLIC_PATH[publicPath]
  if (studio) out.set('studio', studio)
  for (const [k, v] of incoming) out.append(k, v)
  const qs = out.toString()
  return qs ? `/trial?${qs}` : '/trial'
}
