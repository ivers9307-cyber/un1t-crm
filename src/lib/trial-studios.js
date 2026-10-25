// TRIALSTUDIO.2 — the studios the /trial page offers, and what each one sells.
// Stillorgan's memberships live in Glofox, Hatch Street's in un1t.online; each
// studio's landing row carries its own paid_trial block. loadTrialStudios is
// the one place that reads both, so the page and the routes agree on which
// studios are sellable.

import { paidTrialConfigFromBlocks, paidTrialAccountEmailCopy } from '@/lib/paid-trial'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
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
 * A un1t.online studio whose `settings.un1t_online.writes_enabled` is off is
 * not sellable (TRIALSTUDIO.10): the page says "not available online" while
 * the switch is off, as the POST's not_configured does.
 * @returns {Promise<Array<{ key: string, publicPath: string, locationId: string|null,
 *   membershipSource: string|null, block: object|null, product: object|null,
 *   sellable: boolean, config: object|null, unreadable?: true }>>}
 */
export async function loadTrialStudios(db) {
  const empty = (s) => ({ key: s.key, publicPath: s.publicPath, locationId: null, membershipSource: null, block: null, product: null, sellable: false, config: null })
  const unreadableEntry = (s) => ({ ...empty(s), unreadable: true })

  const { data: pages, error } = await db
    .from('landing_page_settings')
    .select('location_id, public_path, blocks, locations:location_id ( membership_source, settings )')
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
    const loc = embedded(page.locations)
    const membershipSource = loc?.membership_source || null
    // Only the switch leaves this function, never the settings object.
    const writesEnabled = un1tWriteSettingsFrom(loc?.settings).writesEnabled
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const block = blocks.find((x) => x && typeof x === 'object' && x.type === 'paid_trial') || null
    const base = { key: studio.key, publicPath: studio.publicPath, locationId, membershipSource, block, product: null }
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
    const config = paidTrialConfigFromBlocks(blocks, studio.publicPath, { product })
    return { ...base, product, sellable: config !== null, config }
  }))
}

/**
 * Final-review F2 — the account explanation email copy of the studio at
 * `locationId` (its paid_trial block's account_email_subject / _body), for
 * the Hatch Street settle sweep. Never throws: an unreadable row, or a studio
 * with no block, answers the defaults (logged with ids only), which are the
 * trial buyer's words, never the class funnel's.
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function readPaidTrialAccountEmailCopy(db, locationId) {
  try {
    const { data, error } = await db
      .from('landing_page_settings')
      .select('public_path, blocks')
      .eq('location_id', locationId)
      .in('public_path', TRIAL_STUDIOS.map((s) => s.publicPath))
    if (error) throw Object.assign(new Error('landing row unreadable'), { code: error.code ?? null })
    const blocks = (Array.isArray(data) ? data : []).flatMap((p) => (Array.isArray(p?.blocks) ? p.blocks : []))
    return paidTrialAccountEmailCopy(blocks)
  } catch (err) {
    logWarn('trial-studios', 'paid_trial email copy unreadable; the defaults are used', { locationId, code: err?.code ?? null })
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
