// PAGES.1 — server readers for landing pages as records: a page is a
// landing_pages row plus its landing_page_studios rows (the studio half of the
// offer, and whether the page is switched on there). This file loads them,
// resolves which studio a visitor means, merges the offer block with that
// studio's half, and answers who may see and edit a page. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md.
//
// SERVER ONLY. STUDIO_ROW_COLUMNS embeds `locations.settings`, which holds
// credentials: it is read on the server and must NEVER be passed to a client
// (a client gets `redactLocationSecrets` output or named columns, never this
// embed). Every read here is tenant-scoped by the caller's org id or by a page
// id the caller already resolved; the request resolver
// (resolvePublicPageRequest) and studioTermsCopy are registered with
// check:location-scoping (scripts/check-location-scoping.mjs SCOPING_HELPERS).

import { mergeOfferBlock, OFFER_BLOCK_TYPE, offerConfigured, defaultAttribution, ATTRIBUTION_KEYS } from '@/lib/landing-page-offers'
import { resolveLandingPath } from '@/lib/public-landing'
import { publicOrgIdForHost } from '@/lib/public-pages-edge'
import { normaliseSlug } from '@/lib/page-slug'
import { TRIAL_STUDIOS } from '@/lib/trial-studios'
import { hasPermissionForLocation } from '@/lib/permissions'
import { isOrgAdmin } from '@/lib/org-admin'
import { getUserLocationIds } from '@/lib/auth'
import { un1tFunnelCopyFromBlocks } from '@/lib/un1t-online-funnel-copy'
import { logWarn } from '@/lib/log'

// The edge-safe half lives in its own module so the proxy can import it.
export { publicOrgIdForHost } from '@/lib/public-pages-edge'

export const PAGE_PUBLISH_STATES = Object.freeze(['draft', 'live', 'coming_soon', 'retired'])

/** Only a live page renders its content. */
export const isPageVisible = (state) => state === 'live'

/** A page the public route answers for at all (draft is a 404). */
export const isPageReachable = (state) => ['live', 'coming_soon', 'retired'].includes(state)

export const PAGE_COLUMNS = 'id, organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state, redirect_to, updated_at'
export const STUDIO_ROW_COLUMNS = 'page_id, location_id, enabled, offer, attribution, sort_order, locations:location_id ( id, name, membership_source, settings )'

export class PageReadError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'PageReadError'
    if (cause) this.cause = cause
  }
}

async function loadStudios(db, page) {
  const { data, error } = await db
    .from('landing_page_studios')
    .select(STUDIO_ROW_COLUMNS)
    .eq('page_id', page.id)
    .order('sort_order')
  if (error) throw new PageReadError('Could not read the page\'s studios', error)
  return { page, studios: data || [] }
}

/** The page at <slug> in an organisation with its studio rows, null when there is none; a failed read throws. */
export async function loadPageBySlug(db, { orgId, slug }) {
  const { data: page, error } = await db
    .from('landing_pages')
    .select(PAGE_COLUMNS)
    .eq('organization_id', orgId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the page', error)
  if (!page) return null
  return loadStudios(db, page)
}

export async function loadPageById(db, id) {
  const { data: page, error } = await db
    .from('landing_pages')
    .select(PAGE_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the page', error)
  if (!page) return null
  return loadStudios(db, page)
}

/** `?studio=hatch` is the old spelling of the public path `hatch-street`; anything else is a slug or junk (null). */
export function studioParamToPublicPath(raw) {
  if (typeof raw !== 'string') return null
  const alias = TRIAL_STUDIOS.find((s) => s.key === raw.trim().toLowerCase())
  if (alias) return alias.publicPath
  return normaliseSlug(raw)
}

/**
 * Which studio a visitor is looking at. scope='one' is the primary's row;
 * scope='all' offers the enabled rows and picks the one whose location_id the
 * caller resolved from `?studio=` (a disabled or unknown id is no studio).
 */
export function resolvePageStudio({ page, studios, studioLocationId }) {
  const rows = studios || []
  if (page.scope === 'one') {
    return { studio: rows.find((r) => r.location_id === page.primary_location_id) || null, picker: [] }
  }
  const picker = rows.filter((r) => r.enabled).sort((a, b) => a.sort_order - b.sort_order)
  const studio = studioLocationId ? picker.find((r) => r.location_id === studioLocationId) || null : null
  return { studio, picker }
}

// PR1 fallbacks: until the studio pages are the only source, a path with no
// kind='studio' page row falls back to landing_page_settings. PR3 deletes
// these two helpers and their call sites.
async function legacyLocationIdForPath(db, publicPath) {
  const { data, error } = await db
    .from('landing_page_settings')
    .select('location_id')
    .eq('public_path', publicPath)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio path', error)
  return data?.location_id || null
}

async function legacyPathForLocation(db, locationId) {
  const { data, error } = await db
    .from('landing_page_settings')
    .select('public_path')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio path', error)
  return data?.public_path || null
}

/**
 * PR1 legacy, deleted in PR3 with the two helpers above: the un1t.online
 * terms-tick wording of a studio (UN1T_FUNNEL_COPY_KEYS), read where /trial
 * and /corp read it today, the class_funnel block on the studio's
 * landing_page_settings row. mig 792 also copies it to the studio page's
 * `chrome.un1t_terms`, which PR3 switches to. Never throws: a miss or a failed
 * read answers the defaults (logged with the id only).
 * @returns {Promise<object>} every UN1T_FUNNEL_COPY_KEYS key, resolved
 */
export async function studioTermsCopy(db, locationId) {
  if (!locationId) return un1tFunnelCopyFromBlocks(null)
  try {
    const { data, error } = await db
      .from('landing_page_settings')
      .select('blocks')
      .eq('location_id', locationId)
      .maybeSingle()
    if (error) throw Object.assign(new Error('landing row unreadable'), { code: error.code ?? null })
    return un1tFunnelCopyFromBlocks(Array.isArray(data?.blocks) ? data.blocks : null)
  } catch (err) {
    logWarn('landing-pages', 'studio terms copy unreadable; defaults used', { locationId, code: err?.code ?? null })
    return un1tFunnelCopyFromBlocks(null)
  }
}

/** A studio's public path (/stillorgan) to its location id, null when no studio has that path. */
export async function locationIdForPublicPath(db, orgId, publicPath) {
  const { data, error } = await db
    .from('landing_pages')
    .select('primary_location_id')
    .eq('organization_id', orgId)
    .eq('kind', 'studio')
    .eq('slug', publicPath)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio page', error)
  if (data?.primary_location_id) return data.primary_location_id
  return legacyLocationIdForPath(db, publicPath)
}

/** A studio's public path: its studio page's slug, null when it has none. */
export async function studioPublicPath(db, locationId) {
  const { data, error } = await db
    .from('landing_pages')
    .select('slug')
    .eq('kind', 'studio')
    .eq('primary_location_id', locationId)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio page', error)
  if (data?.slug) return data.slug
  return legacyPathForLocation(db, locationId)
}

/**
 * PR1 legacy; PR3 reads the kind='studio' page. The studio's own landing copy
 * and public path, read where the processor and Mia's approval route read them
 * today (landing_page_settings by location_id). A miss answers empty; a failed
 * read throws PageReadError (copySourceForRequest catches it).
 * @returns {Promise<{ blocks: object[], publicPath: string | null }>}
 */
export async function studioPageBlocksFor(db, locationId) {
  const { data, error } = await db
    .from('landing_page_settings')
    .select('public_path, blocks')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio page', error)
  return { blocks: Array.isArray(data?.blocks) ? data.blocks : [], publicPath: data?.public_path ?? null }
}

/**
 * The copy a request's confirmation is built from (the class_funnel block's
 * wording, the conversion URL's path): the page the request came from, merged
 * with that page's row for the request's studio, when it carries a page_id;
 * otherwise (or when that page is gone, or has no row for the studio) the
 * studio's own page. Never throws: a failed read logs ids only and falls back,
 * ending in empty copy, which every consumer resolves to its defaults.
 * @returns {Promise<{ blocks: object[], publicPath: string | null }>}
 */
export async function copySourceForRequest(db, { pageId, locationId }) {
  if (pageId) {
    try {
      const loaded = await loadPageById(db, pageId)
      const studio = loaded?.studios.find((s) => s.location_id === locationId) || null
      if (loaded && studio) {
        return {
          blocks: mergedBlocksFor({ page: loaded.page, studio }),
          publicPath: await studioPublicPath(db, locationId),
        }
      }
    } catch (err) {
      logWarn('landing-pages', 'request page unreadable; the studio page is used', { pageId, locationId, code: err?.cause?.code ?? err?.code ?? null })
    }
  }
  try {
    return await studioPageBlocksFor(db, locationId)
  } catch (err) {
    logWarn('landing-pages', 'studio page copy unreadable; defaults used', { locationId, code: err?.cause?.code ?? err?.code ?? null })
    return { blocks: [], publicPath: null }
  }
}

/**
 * The page's blocks with the offer block (first of the offer type's block type)
 * merged with the studio's half. A campaign_funnel block gets the page slug
 * back as `campaign`: the split drops that key and campaignFunnelConfig falls
 * back on it for the tag, lead source and event source URL.
 */
export function mergedBlocksFor({ page, studio }) {
  const blocks = Array.isArray(page.blocks) ? page.blocks : []
  const offerType = OFFER_BLOCK_TYPE[page.offer_type]
  if (!offerType) return blocks.slice()
  const idx = blocks.findIndex((b) => b?.type === offerType)
  if (idx === -1) return blocks.slice()
  const merged = mergeOfferBlock(blocks[idx], studio)
  if (offerType === 'campaign_funnel') merged.campaign = page.slug
  return blocks.map((b, i) => (i === idx ? merged : b))
}

/** Is the offer ready to take a customer at this studio? */
export function offerReady({ page, studio, landingPath, product = null }) {
  const blockType = OFFER_BLOCK_TYPE[page.offer_type]
  if (!blockType) return false
  const merged = mergedBlocksFor({ page, studio }).find((b) => b?.type === blockType)
  if (!merged) return false
  return offerConfigured(blockType, merged, { landingPath, product })
}

const isMaster = (user) => Boolean(user && (user.isMaster || user.role === 'master'))

/** Master, an org admin of the page's org, or (scope one) someone assigned to its studio. */
export function canViewPage(user, page) {
  if (!user) return false
  if (isMaster(user) || isOrgAdmin(user, page.organization_id)) return true
  return page.scope === 'one' && getUserLocationIds(user).includes(page.primary_location_id)
}

/**
 * scope one: the landing_page permission at its studio; scope all: an org admin.
 * No master shortcut: a master passes through the helpers (isOrgAdmin admits
 * one; resolvePermission admits one once the studio's feature gate is on).
 */
export function canEditPage(user, page) {
  if (!user) return false
  if (page.scope === 'one') return hasPermissionForLocation(user, page.primary_location_id, 'landing_page')
  return isOrgAdmin(user, page.organization_id)
}

const NOT_FOUND = Object.freeze({ ok: false, reason: 'not_found' })
const UNREADABLE = Object.freeze({ ok: false, reason: 'unreadable' })
const given = (v) => typeof v === 'string' && v.trim() !== ''

// The row's attribution values that hold one (a blank string is no value),
// only the three attribution keys.
function rowAttribution(studioRow) {
  const raw = studioRow?.attribution && typeof studioRow.attribution === 'object' ? studioRow.attribution : {}
  const out = {}
  for (const key of ATTRIBUTION_KEYS) {
    if (given(raw[key])) out[key] = raw[key].trim()
  }
  return out
}

// PR1 legacy, deleted in PR3: a request with no page names a studio by its
// landing_page_settings.public_path, read exactly as the public routes read it
// today. A throw propagates, as it did from each route's own read (a route
// that caught one keeps catching it).
async function resolveLegacyRequest(db, legacyPath) {
  const publicPath = resolveLandingPath(legacyPath)
  const { data, error } = await db.from('landing_page_settings')
    .select('location_id, public_path, blocks').eq('public_path', publicPath).maybeSingle()
  if (error) return UNREADABLE
  if (!data?.location_id) return NOT_FOUND
  return {
    ok: true, pageId: null, page: null, studioRow: null,
    locationId: data.location_id, publicPath, blocks: data.blocks, attribution: null,
  }
}

/**
 * Which page, studio and attribution a public API request is about.
 *
 * With `page` (a slug): the live campaign page of that slug in the host's
 * organisation (draft, coming_soon and retired answer not_found: only a live
 * page takes a customer; in PR1 a studio page is not_found too). scope 'one' answers for its primary studio only: a `studio` that
 * names any other studio (or nothing) is not_found, so a one-studio page can
 * never be booked at another studio. scope 'all' needs `studio` (a public
 * path, or the old `hatch` spelling): missing is studio_required, a studio the
 * page is not switched on at is not_found. Platform ids, price and
 * attribution come from the page's studio row, never the request:
 * `attribution` is the default for the studio path and slug with the row's
 * non-blank values over it. Every read is scoped by the organisation and slug,
 * then the page id; a failed read is unreadable, never a refusal.
 *
 * Without `page`: PR1 legacy (deleted in PR3), `legacyPath` through
 * resolveLandingPath and its landing_page_settings row; pageId, page,
 * studioRow and attribution are null (the route derives attribution from the
 * blocks as it always has).
 *
 * `not_configured` is never answered here: each route judges its offer's
 * readiness with its own config function.
 *
 * @returns {Promise<{ ok: true, pageId: string|null, page: object|null, studioRow: object|null,
 *   locationId: string, publicPath: string, blocks: Array, attribution: object|null }
 *   | { ok: false, reason: 'not_found' | 'not_configured' | 'studio_required' | 'unreadable' }>}
 */
export async function resolvePublicPageRequest(db, { hostname = null, page = null, studio = null, legacyPath = null } = {}) {
  if (!given(page)) return resolveLegacyRequest(db, legacyPath)
  const slug = normaliseSlug(page)
  if (!slug) return NOT_FOUND
  try {
    const orgId = await publicOrgIdForHost(hostname)
    const loaded = await loadPageBySlug(db, { orgId, slug })
    if (!loaded) return NOT_FOUND
    const { page: row, studios } = loaded
    if (!isPageVisible(row.publish_state)) return NOT_FOUND
    // PR1: studio pages still serve from landing_page_settings; PR3 lifts this and seeds their attribution.
    if (row.kind !== 'campaign') return NOT_FOUND

    const named = given(studio)
    const requested = named ? studioParamToPublicPath(studio) : null
    if (named && !requested) return NOT_FOUND
    let studioRow = null
    if (row.scope === 'one') {
      if (requested) {
        const locationId = await locationIdForPublicPath(db, orgId, requested)
        if (!locationId || locationId !== row.primary_location_id) return NOT_FOUND
      }
      studioRow = resolvePageStudio({ page: row, studios }).studio
      if (!studioRow?.enabled) return NOT_FOUND
    } else if (row.scope === 'all') {
      if (!requested) return { ok: false, reason: 'studio_required' }
      const locationId = await locationIdForPublicPath(db, orgId, requested)
      if (!locationId) return NOT_FOUND
      studioRow = resolvePageStudio({ page: row, studios, studioLocationId: locationId }).studio
      if (!studioRow) return NOT_FOUND
    } else {
      return NOT_FOUND
    }

    // The studio's public path keys the rate limits, the terms page and the
    // stored landing_path: a studio with none cannot take a request.
    const publicPath = await studioPublicPath(db, studioRow.location_id)
    if (!publicPath) return NOT_FOUND
    return {
      ok: true,
      pageId: row.id,
      page: row,
      studioRow,
      locationId: studioRow.location_id,
      publicPath,
      blocks: mergedBlocksFor({ page: row, studio: studioRow }),
      attribution: { ...defaultAttribution({ publicPath, slug: row.slug }), ...rowAttribution(studioRow) },
    }
  } catch (e) {
    logWarn('landing-pages', 'public page request unreadable', { slug, code: e?.cause?.code ?? e?.code ?? null })
    return UNREADABLE
  }
}

/**
 * The public routes' answer to a refused page request (POST shape):
 * studio_required 400, unreadable 503 (a failed read is never a refusal),
 * anything else 404 not_found, so a page or studio id cannot be told apart
 * from no page at all.
 * @returns {{ status: number, body: object }}
 */
export function pageRequestRefusal(reason) {
  if (reason === 'studio_required') return { status: 400, body: { success: false, error: 'studio_required' } }
  if (reason === 'unreadable') {
    return { status: 503, body: { success: false, code: 'unavailable', error: 'Something went wrong on our side. Please try again in a moment.' } }
  }
  return { status: 404, body: { success: false, error: 'not_found' } }
}
