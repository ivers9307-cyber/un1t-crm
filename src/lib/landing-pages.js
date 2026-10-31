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

import {
  mergeOfferBlock, OFFER_BLOCK_TYPE, offerConfigured, defaultAttribution, ATTRIBUTION_KEYS,
  splitOfferBlock, offerTypeOfBlock, OFFER_TYPE_LABELS,
} from '@/lib/landing-page-offers'
import { newBlockOfType, newBlockId, defaultBlocks } from '@/lib/landing-page-blocks'
import { resolveLandingPath } from '@/lib/public-landing'
import { publicOrgIdForHost } from '@/lib/public-pages-edge'
import { normaliseSlug, slugProblem } from '@/lib/page-slug'
import { toSlug } from '@/lib/slug'
import { TRIAL_STUDIOS, trialEntryFromRow } from '@/lib/trial-studios'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { hasPermissionForLocation } from '@/lib/permissions'
import { isOrgAdmin, adminOrganizationIds } from '@/lib/org-admin'
import { LANDING_PAGE_PUBLISH_STATES } from '@/lib/landing-page-schemas'
import { UUID_SHAPE } from '@/lib/uuid-shape'
import { un1tFunnelCopyFromTerms } from '@/lib/un1t-online-funnel-copy'
import { logWarn, logError } from '@/lib/log'

// The edge-safe half lives in its own module so the proxy can import it.
export { publicOrgIdForHost } from '@/lib/public-pages-edge'

export const PAGE_PUBLISH_STATES = LANDING_PAGE_PUBLISH_STATES

/** Only a live page renders its content. */
export const isPageVisible = (state) => state === 'live'

/** A page the public route answers for at all (draft is a 404). */
export const isPageReachable = (state) => ['live', 'coming_soon', 'retired'].includes(state)

export const PAGE_COLUMNS = 'id, organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state, redirect_to, updated_at'
export const STUDIO_ROW_COLUMNS = 'page_id, location_id, enabled, offer, attribution, sort_order, locations:location_id ( id, name, membership_source, settings, timezone )'

export class PageReadError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'PageReadError'
    if (cause) this.cause = cause
  }
}

/**
 * The studio rows that belong to a page: a one-studio page has exactly one,
 * its primary's (spec §1). Any other row a one-studio page holds (a page
 * created before createPage inserted the primary's only) is ignored
 * everywhere: the editor, the studio save (404), the publish gate, the list.
 */
export function pageStudioRows(page, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (page?.scope !== 'one') return list
  return list.filter((r) => r?.location_id === page.primary_location_id)
}

async function loadStudios(db, page) {
  const { data, error } = await db
    .from('landing_page_studios')
    .select(STUDIO_ROW_COLUMNS)
    .eq('page_id', page.id)
    .order('sort_order')
  if (error) throw new PageReadError('Could not read the page\'s studios', error)
  return { page, studios: pageStudioRows(page, data) }
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

/**
 * The un1t.online terms-tick wording of a studio (UN1T_FUNNEL_COPY_KEYS): the
 * studio page's `chrome.un1t_terms` (the kind='studio' row whose primary is
 * the location; mig 792 copied the legacy class_funnel wording there). Never
 * throws: a miss or a failed read answers the defaults (logged with the id
 * only), and each blank key is its default (un1tFunnelCopyFromTerms).
 * @returns {Promise<object>} every UN1T_FUNNEL_COPY_KEYS key, resolved
 */
export async function studioTermsCopy(db, locationId) {
  if (!locationId) return un1tFunnelCopyFromTerms(null)
  try {
    const { data, error } = await db
      .from('landing_pages')
      .select('chrome')
      .eq('kind', 'studio')
      .eq('primary_location_id', locationId)
      .maybeSingle()
    if (error) throw Object.assign(new Error('studio page unreadable'), { code: error.code ?? null })
    const chrome = data?.chrome && typeof data.chrome === 'object' ? data.chrome : null
    return un1tFunnelCopyFromTerms(chrome?.un1t_terms)
  } catch (err) {
    logWarn('landing-pages', 'studio terms copy unreadable; defaults used', { locationId, code: err?.code ?? null })
    return un1tFunnelCopyFromTerms(null)
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
  return data?.primary_location_id || null
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
  return data?.slug || null
}

/**
 * A studio page's `chrome.un1t_terms` as a plain object (never null): the
 * UNRESOLVED stored value, blank or missing keys and all. Pass it through
 * un1tFunnelCopyFromTerms (or un1tTermsPayload({ terms })) to get the words.
 */
const termsOf = (page) => (page?.chrome && typeof page.chrome === 'object' && page.chrome.un1t_terms
  && typeof page.chrome.un1t_terms === 'object' ? page.chrome.un1t_terms : {})

/**
 * The studio's own page copy and public path, for the readers that hold only a
 * location id (Mia's approval route, the booking processor, the WhatsApp
 * flow): the kind='studio' page whose primary is the studio, its blocks merged
 * with its studio row, its slug, and its `chrome.un1t_terms`. A studio with no
 * page answers empty; a failed read throws PageReadError (callers decide:
 * copySourceForRequest catches it).
 * @returns {Promise<{ blocks: object[], publicPath: string | null, terms: object }>}
 */
export async function studioPageBlocksFor(db, locationId) {
  const { data: page, error } = await db
    .from('landing_pages')
    .select(PAGE_COLUMNS)
    .eq('kind', 'studio')
    .eq('primary_location_id', locationId)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the studio page', error)
  if (!page) return { blocks: [], publicPath: null, terms: {} }
  const { studios } = await loadStudios(db, page)
  const studio = studios.find((s) => s.location_id === locationId) || null
  return {
    blocks: studio ? mergedBlocksFor({ page, studio }) : (Array.isArray(page.blocks) ? page.blocks : []),
    publicPath: page.slug || null,
    terms: termsOf(page),
  }
}

/**
 * The copy a request's confirmation is built from (the class_funnel block's
 * wording, the conversion URL's path, the terms-tick wording): the page the
 * request came from, merged with that page's row for the request's studio,
 * when it carries a page_id; otherwise (or when that page is gone, or has no
 * row for the studio) the studio's own page. `terms` is always the STUDIO
 * page's `chrome.un1t_terms` (the tick is the studio's wording, whichever page
 * the request came from). Never throws: a failed read logs ids only and falls
 * back, ending in empty copy, which every consumer resolves to its defaults.
 * @returns {Promise<{ blocks: object[], publicPath: string | null, terms: object }>}
 */
export async function copySourceForRequest(db, { pageId, locationId }) {
  if (pageId) {
    try {
      const loaded = await loadPageById(db, pageId)
      const studio = loaded?.studios.find((s) => s.location_id === locationId) || null
      if (loaded && studio) {
        const [publicPath, terms] = await Promise.all([
          studioPublicPath(db, locationId),
          studioTermsOf(db, loaded.page, locationId),
        ])
        return { blocks: mergedBlocksFor({ page: loaded.page, studio }), publicPath, terms }
      }
    } catch (err) {
      logWarn('landing-pages', 'request page unreadable; the studio page is used', { pageId, locationId, code: err?.cause?.code ?? err?.code ?? null })
    }
  }
  try {
    return await studioPageBlocksFor(db, locationId)
  } catch (err) {
    logWarn('landing-pages', 'studio page copy unreadable; defaults used', { locationId, code: err?.cause?.code ?? err?.code ?? null })
    return { blocks: [], publicPath: null, terms: {} }
  }
}

// The studio's terms wording as seen from a resolved page, to pass through
// un1tFunnelCopyFromTerms: a studio page of that studio carries it itself
// (the unresolved chrome.un1t_terms); any other page (a campaign) reads the
// studio's page (studioTermsCopy never throws, a blip is the resolved
// defaults). Either shape is accepted by un1tFunnelCopyFromTerms.
async function studioTermsOf(db, page, locationId) {
  if (page?.kind === 'studio' && page.primary_location_id === locationId) return termsOf(page)
  return studioTermsCopy(db, locationId)
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

/**
 * Master, an org admin of the page's org, or someone holding `landing_page`
 * (spec §8): at its studio (scope one), or at any of their studios in the
 * page's organisation (scope all, read-only for a non-admin: canEditPage
 * still asks for an org admin). A coach or receptionist without the
 * permission sees no page at all.
 */
export function canViewPage(user, page) {
  if (!user || !page) return false
  if (isMaster(user) || isOrgAdmin(user, page.organization_id)) return true
  if (page.scope === 'one') return hasPermissionForLocation(user, page.primary_location_id, 'landing_page')
  if (page.scope === 'all') {
    return Boolean(page.organization_id) && (user.locations || []).some(
      (l) => l?.organization_id === page.organization_id && hasPermissionForLocation(user, l.id, 'landing_page'),
    )
  }
  return false
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

/**
 * The attribution a studio row stands for: the default for the studio path and
 * the page slug, with the row's non-blank values over it (never the request's).
 */
export function studioAttribution({ page, studioRow, publicPath }) {
  return { ...defaultAttribution({ publicPath, slug: page.slug }), ...rowAttribution(studioRow) }
}

// A request with no `page` names a STUDIO PAGE by its slug (the old
// `path`/`public_path` param: /stillorgan's own lead form, class funnel and
// paid-trial card post this way). Same answer shape as the page form, for the
// studio page's primary row. Only a live studio page takes a request (a draft
// is a miss: stricter than the retired settings row, which had no state).
// A failed read is unreadable, never a refusal.
async function resolveLegacyRequest(db, legacyPath, hostname, requireEnabled) {
  const slug = resolveLandingPath(legacyPath)
  try {
    const orgId = await publicOrgIdForHost(hostname)
    const loaded = await loadPageBySlug(db, { orgId, slug })
    if (!loaded) return NOT_FOUND
    const { page, studios } = loaded
    if (page.kind !== 'studio' || !isPageVisible(page.publish_state)) return NOT_FOUND
    const studioRow = resolvePageStudio({ page, studios }).studio
    if (!studioRow || (requireEnabled && !studioRow.enabled) || !page.primary_location_id) return NOT_FOUND
    return {
      ok: true,
      pageId: page.id,
      page,
      studioRow,
      locationId: page.primary_location_id,
      publicPath: slug,
      blocks: mergedBlocksFor({ page, studio: studioRow }),
      attribution: studioAttribution({ page, studioRow, publicPath: slug }),
      terms: termsOf(page),
    }
  } catch (e) {
    logWarn('landing-pages', 'studio page request unreadable', { slug, code: e?.cause?.code ?? e?.code ?? null })
    return UNREADABLE
  }
}

/**
 * Which page, studio and attribution a public API request is about.
 *
 * With `page` (a slug): the live page of that slug in the host's organisation
 * (draft, coming_soon and retired answer not_found: only a live page takes a
 * customer). A studio page resolves like a one-studio page. scope 'one' answers
 * for its primary studio only: a `studio` that names any other studio (or
 * nothing) is not_found, so a one-studio page can never be booked at another
 * studio. scope 'all' needs `studio` (a public path, or the old `hatch`
 * spelling): missing is studio_required, a studio the page is not switched on
 * at is not_found. Platform ids, price and attribution come from the page's
 * studio row, never the request: `attribution` is the default for the studio
 * path and slug with the row's non-blank values over it. Every read is scoped
 * by the organisation and slug, then the page id; a failed read is unreadable,
 * never a refusal.
 *
 * Without `page`: `legacyPath` (the old `path` / `public_path` param, which
 * /stillorgan's own blocks still post) names a STUDIO PAGE by its slug
 * (resolveLegacyRequest): the same answer, for that page's primary row.
 *
 * `terms` is the studio's terms-tick wording (its studio page's
 * `chrome.un1t_terms`); hand it to un1tTermsPayload / un1tFunnelCopyFromTerms.
 *
 * `requireEnabled` (default true): a studio row switched off refuses the
 * request, as an OFFER route (classes, class-booking, trial-purchases,
 * corp-claims) needs. A content-block route (leads, funnel-event) passes false:
 * a live page with a row for the studio takes the request even when that row's
 * offer is switched off.
 *
 * `not_configured` is never answered here: each route judges its offer's
 * readiness with its own config function.
 *
 * @returns {Promise<{ ok: true, pageId: string, page: object, studioRow: object,
 *   locationId: string, publicPath: string, blocks: Array, attribution: object, terms: object }
 *   | { ok: false, reason: 'not_found' | 'not_configured' | 'studio_required' | 'unreadable' }>}
 */
export async function resolvePublicPageRequest(db, { hostname = null, page = null, studio = null, legacyPath = null, requireEnabled = true } = {}) {
  if (!given(page)) return resolveLegacyRequest(db, legacyPath, hostname, requireEnabled)
  const slug = normaliseSlug(page)
  if (!slug) return NOT_FOUND
  try {
    const orgId = await publicOrgIdForHost(hostname)
    const loaded = await loadPageBySlug(db, { orgId, slug })
    if (!loaded) return NOT_FOUND
    const { page: row, studios } = loaded
    if (!isPageVisible(row.publish_state)) return NOT_FOUND

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
      if (!studioRow || (requireEnabled && !studioRow.enabled)) return NOT_FOUND
    } else if (row.scope === 'all') {
      if (!requested) return { ok: false, reason: 'studio_required' }
      const locationId = await locationIdForPublicPath(db, orgId, requested)
      if (!locationId) return NOT_FOUND
      // An offer route needs the page switched on at the studio (the picker's enabled rows);
      // a content-block route (requireEnabled false) takes any row the page holds for it.
      studioRow = requireEnabled
        ? resolvePageStudio({ page: row, studios, studioLocationId: locationId }).studio
        : studios.find((r) => r.location_id === locationId) || null
      if (!studioRow) return NOT_FOUND
    } else {
      return NOT_FOUND
    }

    // The studio's public path keys the rate limits, the terms page and the
    // stored landing_path: a studio with none cannot take a request.
    const [publicPath, terms] = await Promise.all([
      studioPublicPath(db, studioRow.location_id),
      studioTermsOf(db, row, studioRow.location_id),
    ])
    if (!publicPath) return NOT_FOUND
    return {
      ok: true,
      pageId: row.id,
      page: row,
      studioRow,
      locationId: studioRow.location_id,
      publicPath,
      blocks: mergedBlocksFor({ page: row, studio: studioRow }),
      attribution: studioAttribution({ page: row, studioRow, publicPath }),
      terms,
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

// ---------------------------------------------------------------------------
// The pages API (/api/landing-pages*): readiness, the list, create, save.
// ---------------------------------------------------------------------------

const embeddedOne = (v) => (Array.isArray(v) ? v[0] : v) || null
const READ_PAGE_SIZE = 1000

const READY = Object.freeze({ ready: true, reason: 'ready' })
const NEEDS_PLAN = Object.freeze({ ready: false, reason: 'needs_plan' })
const NO_PLATFORM = Object.freeze({ ready: false, reason: 'no_platform' })

/** Every row a query builds, paged past the 1,000-row cap; the builder must carry its own .order(). */
async function readAllRows(build, what) {
  const out = []
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    const { data, error } = await build().range(from, from + READ_PAGE_SIZE - 1)
    if (error) throw new PageReadError(`Could not read ${what}`, error)
    const rows = Array.isArray(data) ? data : []
    out.push(...rows)
    if (rows.length < READ_PAGE_SIZE) return out
  }
}

/**
 * Is this studio row ready to take a customer? The ONE rule behind the list's
 * chip, the publish gate and the studio save's answer.
 *   ready        the merged offer passes the public route's own config check;
 *   needs_plan   the studio can sell, but the plan / product / keywords are missing;
 *   no_platform  the studio has no public path, or (paid_trial) it is a
 *                un1t.online studio with writes off, or neither Glofox nor
 *                un1t.online is its membership source.
 * A page with no offer type has nothing to sell and is ready everywhere.
 * `row` carries the STUDIO_ROW_COLUMNS `locations` embed. A failed read
 * (the public path, the un1t.online product) THROWS PageReadError: the caller
 * answers 503, never "not ready". `publicPath` may be passed when the caller
 * already read it (studioPublicPath), so a list reads each studio once.
 * @returns {Promise<{ ready: boolean, reason: 'ready' | 'needs_plan' | 'no_platform' }>}
 */
export async function studioRowReadiness(db, { page, row, publicPath }) {
  const blockType = OFFER_BLOCK_TYPE[page.offer_type]
  if (!blockType) return READY
  const path = publicPath !== undefined ? publicPath : await studioPublicPath(db, row.location_id)
  if (!path) return NO_PLATFORM
  if (blockType === 'paid_trial') {
    const loc = embeddedOne(row.locations)
    const source = loc?.membership_source || null
    if (source === 'un1t_online') {
      if (!un1tWriteSettingsFrom(loc?.settings).writesEnabled) return NO_PLATFORM
      const mergedBlock = mergedBlocksFor({ page, studio: row }).find((b) => b?.type === 'paid_trial') || null
      const entry = await trialEntryFromRow(db, { row, publicPath: path, mergedBlock })
      if (entry.unreadable) throw new PageReadError('Could not read the studio\'s un1t.online product')
      return entry.sellable ? READY : NEEDS_PLAN
    }
    if (source !== 'glofox') return NO_PLATFORM
  }
  return offerReady({ page, studio: row, landingPath: path }) ? READY : NEEDS_PLAN
}

/**
 * A studio row as a client may see it: never the `locations.settings` embed.
 * `publicPath` is the studio's public path (studioPublicPath) when the caller
 * read it, so the editor can show the default tag; null when unknown.
 */
export function studioRowView(row, { publicPath = null } = {}) {
  const loc = embeddedOne(row?.locations)
  return {
    location_id: row.location_id,
    name: loc?.name || null,
    public_path: typeof publicPath === 'string' && publicPath ? publicPath : null,
    membership_source: loc?.membership_source || null,
    enabled: Boolean(row.enabled),
    offer: row.offer && typeof row.offer === 'object' ? row.offer : {},
    attribution: row.attribution && typeof row.attribution === 'object' ? row.attribution : {},
    sort_order: Number.isFinite(row.sort_order) ? row.sort_order : 0,
  }
}

// One vocabulary for the offer types: the New page dialog's labels.
export { OFFER_TYPE_LABELS }

// The studio offer key that names what is on sale, by offer type.
const OFFER_NAME_KEY = Object.freeze({
  paid_trial: 'product_name',
  class_funnel: 'trial_plan_code',
  one_class: 'class_keywords',
  promo_credits: 'promo_key',
})

/**
 * The list's "Offer" cell: the type, then the one studio's plan or product
 * name, or "per studio". The plan, product and keywords are studio-half
 * values (EDITGATE.1), so only an editor (`canEdit`) gets them; a viewer gets
 * the type label alone.
 */
export function offerSummary(page, rows, { canEdit = false } = {}) {
  const label = OFFER_TYPE_LABELS[page.offer_type] || OFFER_TYPE_LABELS.none
  if (!OFFER_BLOCK_TYPE[page.offer_type]) return label
  if (!canEdit) return label
  if (page.scope === 'all') return `${label}, per studio`
  const row = (rows || []).find((r) => r.location_id === page.primary_location_id)
  const raw = row?.offer?.[OFFER_NAME_KEY[page.offer_type]]
  const detail = typeof raw === 'string' ? raw.trim() : ''
  return detail ? `${label}: ${detail}` : label
}

// The organisations whose pages a non-master may be shown: every org they
// hold a studio in, and every org they administer.
function viewerOrgIds(user) {
  const ids = new Set(adminOrganizationIds(user))
  for (const l of user?.locations || []) if (l?.organization_id) ids.add(l.organization_id)
  return [...ids]
}

const LIST_FIELDS = ['id', 'organization_id', 'slug', 'title', 'kind', 'scope', 'primary_location_id', 'offer_type', 'publish_state', 'redirect_to', 'updated_at']

/**
 * The Pages list: every page of the organisations the caller holds a studio in
 * or administers (a master: every organisation), kept only where
 * canViewPage admits them, each with its studio rows' readiness, the offer
 * summary and whether the caller may edit it. Studio pages are listed too.
 * Blocks and chrome stay off the list. A failed read throws PageReadError
 * (the route answers 503), never a wrong chip.
 */
export async function listPagesForUser(db, user) {
  if (!user) return []
  const orgIds = isMaster(user) ? null : viewerOrgIds(user)
  if (orgIds && orgIds.length === 0) return []
  const pages = (await readAllRows(() => {
    let q = db.from('landing_pages').select(PAGE_COLUMNS)
    if (orgIds) q = q.in('organization_id', orgIds)
    return q.order('organization_id').order('slug')
  }, 'the pages')).filter((p) => canViewPage(user, p))
  if (!pages.length) return []

  const rows = await readAllRows(() => db.from('landing_page_studios')
    .select(STUDIO_ROW_COLUMNS)
    .in('page_id', pages.map((p) => p.id))
    .order('page_id').order('location_id'), 'the pages\' studios')
  const byPage = new Map()
  for (const r of rows) {
    if (!byPage.has(r.page_id)) byPage.set(r.page_id, [])
    byPage.get(r.page_id).push(r)
  }
  for (const p of pages) if (byPage.has(p.id)) byPage.set(p.id, pageStudioRows(p, byPage.get(p.id)))

  // One public-path read per studio, only for pages that sell something.
  const needPath = new Set()
  for (const p of pages) {
    if (!OFFER_BLOCK_TYPE[p.offer_type]) continue
    for (const r of byPage.get(p.id) || []) needPath.add(r.location_id)
  }
  const paths = new Map(await Promise.all([...needPath].map(async (id) => [id, await studioPublicPath(db, id)])))

  return Promise.all(pages.map(async (page) => {
    const pageRows = (byPage.get(page.id) || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    const studios = await Promise.all(pageRows.map(async (row) => {
      const readiness = await studioRowReadiness(db, { page, row, publicPath: paths.has(row.location_id) ? paths.get(row.location_id) : undefined })
      return { location_id: row.location_id, name: embeddedOne(row.locations)?.name || null, enabled: Boolean(row.enabled), ...readiness }
    }))
    const out = Object.fromEntries(LIST_FIELDS.map((k) => [k, page[k] ?? null]))
    const canEdit = canEditPage(user, page)
    return { ...out, studios, offer_summary: offerSummary(page, pageRows, { canEdit }), can_edit: canEdit }
  }))
}

/** The content blocks of a page (every block that is not an offer block), with fresh ids. */
export function copiedContentBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && typeof b === 'object' && offerTypeOfBlock(b.type) === null)
    .map((b) => ({ ...structuredClone(b), id: newBlockId() }))
}

/** What a new page starts with: the page half of its offer block, or a hero for no offer. */
export function starterBlocks(offerType, brand) {
  const blockType = OFFER_BLOCK_TYPE[offerType]
  if (!blockType) return [newBlockOfType('hero', { brand })]
  return [splitOfferBlock(newBlockOfType(blockType, { brand })).page]
}

/**
 * The blocks a page stores: never a studio half. Every offer-type block keeps
 * only its page half (splitOfferBlock). On a page with an offer type the
 * offer block must be there: first on a campaign page (the editor pins it at
 * index 0), anywhere on a studio page (mig 792 kept each studio's own order).
 * @returns {{ ok: true, blocks: object[] } | { ok: false, error: 'offer_block_required' }}
 */
export function pageBlocksToStore(page, blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const blockType = OFFER_BLOCK_TYPE[page.offer_type]
  if (blockType) {
    const present = page.kind === 'studio'
      ? list.some((b) => b?.type === blockType)
      : list[0]?.type === blockType
    if (!present) return { ok: false, error: 'offer_block_required' }
  }
  return {
    ok: true,
    blocks: list.map((b) => (offerTypeOfBlock(b?.type) !== null ? splitOfferBlock(b).page : b)),
  }
}

/**
 * The page's chrome after a save: the stored chrome with the sent keys over
 * it (un1t_terms merged key by key). `was_live` is the server's: a sent value
 * is ignored and the stored one kept.
 */
export function mergedChrome(stored, sent) {
  const base = stored && typeof stored === 'object' ? stored : {}
  const { was_live: _ignored, un1t_terms: terms, ...rest } = sent || {}
  const out = { ...base, ...rest }
  if (terms) out.un1t_terms = { ...(base.un1t_terms || {}), ...terms }
  if (base.was_live === true) out.was_live = true
  else delete out.was_live
  return out
}

/** Has the page been seen by the public at its slug? (publish stamps was_live; a backfilled live page predates it.) */
export const pageWasLive = (page) => page?.chrome?.was_live === true || page?.publish_state === 'live'

const isUniqueViolation = (error) => error?.code === '23505'

/**
 * Create a campaign page: the starter blocks (plus the content blocks of
 * `startFrom`, a page the route has already checked the caller may view),
 * then its studio rows, with the default attribution for each studio's public
 * path (none when it has no path). A one-studio page gets exactly one row,
 * its primary's, switched on (spec §1); an all-studios page one row per
 * ACTIVE studio of the organisation, sorted by name, switched off.
 * Every read happens before the first write; a read failure throws
 * PageReadError. A studio-row insert that fails removes the page again.
 * @returns {Promise<{ ok: true, page: object, studios: object[] } | { ok: false, reason: 'taken' | 'failed', error?: object }>}
 */
export async function createPage(db, { input, orgId, userId, brand, startFrom = null }) {
  const slug = normaliseSlug(input.slug)
  const primary = input.scope === 'one' ? input.primary_location_id : null
  const { data: locs, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('name')
  if (locErr) throw new PageReadError('Could not read the organisation\'s studios', locErr)
  const active = Array.isArray(locs) ? locs : []
  const studios = primary ? active.filter((l) => l.id === primary) : active
  const paths = await Promise.all(studios.map((l) => studioPublicPath(db, l.id)))

  const blocks = [...starterBlocks(input.offer_type, brand), ...copiedContentBlocks(startFrom?.blocks)]
  const { data: page, error: pageErr } = await db
    .from('landing_pages')
    .insert({
      organization_id: orgId,
      slug,
      title: input.title,
      kind: 'campaign',
      scope: input.scope,
      primary_location_id: primary,
      offer_type: input.offer_type,
      blocks,
      chrome: { noindex: true, tone: 'dark' },
      publish_state: 'draft',
      created_by: userId,
      updated_by: userId,
    })
    .select(PAGE_COLUMNS)
    .single()
  if (pageErr || !page) return { ok: false, reason: isUniqueViolation(pageErr) ? 'taken' : 'failed', error: pageErr }

  const rows = studios.map((l, i) => ({
    page_id: page.id,
    location_id: l.id,
    enabled: Boolean(primary),
    offer: {},
    attribution: paths[i] ? defaultAttribution({ publicPath: paths[i], slug }) : {},
    sort_order: i,
    updated_by: userId,
  }))
  if (rows.length) {
    const { error: rowsErr } = await db.from('landing_page_studios').insert(rows)
    if (rowsErr) {
      const { error: undoErr } = await db.from('landing_pages').delete().eq('id', page.id)
      if (undoErr) logError('landing-pages', 'new page without studio rows could not be removed', { pageId: page.id, code: undoErr.code ?? null })
      return { ok: false, reason: 'failed', error: rowsErr }
    }
  }
  return { ok: true, page, studios: rows.map((r, i) => ({ ...r, name: studios[i].name })) }
}

/**
 * Save a page row (by id; the caller checked who may). `patch` is the column
 * values to write, `updated_by` included.
 * @returns {Promise<{ ok: true, page: object } | { ok: false, reason: 'taken' | 'failed' | 'gone', error?: object }>}
 */
export async function updatePageRow(db, pageId, patch) {
  const { data, error } = await db
    .from('landing_pages')
    .update(patch)
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle()
  if (error) return { ok: false, reason: isUniqueViolation(error) ? 'taken' : 'failed', error }
  if (!data) return { ok: false, reason: 'gone' }
  return { ok: true, page: data }
}

/**
 * Rename a page's slug together with the rest of `patch`. When the page has
 * been live, its old slug becomes a retired page that sends visitors to the
 * new one, written in the same request. When that row cannot be written the
 * rename is undone (every patched column back to its loaded value, the slug
 * included) and the answer is `retire_failed`: nothing changed, try again.
 * Only when the undo fails too is the rename kept, answered with
 * `retiredError` and `rollbackError` (the caller logs both and answers 500
 * with the renamed page).
 * @returns {Promise<{ ok: true, page: object, retired: object | null, retiredError?: object, rollbackError?: object }
 *   | { ok: false, reason: 'taken' | 'failed' | 'gone' | 'retire_failed', error?: object }>}
 */
export async function renameSlug(db, { page, slug, patch, userId }) {
  const saved = await updatePageRow(db, page.id, { ...patch, slug })
  if (!saved.ok) return saved
  if (!pageWasLive(page)) return { ok: true, page: saved.page, retired: null }
  const { data: retired, error } = await db
    .from('landing_pages')
    .insert({
      organization_id: page.organization_id,
      slug: page.slug,
      title: `${page.title} (moved)`,
      kind: 'campaign',
      scope: page.scope,
      primary_location_id: page.primary_location_id,
      // A redirect sells nothing and has no studio rows.
      offer_type: 'none',
      blocks: [],
      chrome: { noindex: true },
      publish_state: 'retired',
      redirect_to: `/${slug}`,
      created_by: userId,
      updated_by: userId,
    })
    .select(PAGE_COLUMNS)
    .maybeSingle()
  if (!error && retired) return { ok: true, page: saved.page, retired }

  const retiredError = error || { message: 'no row' }
  const restore = { updated_by: userId }
  for (const key of Object.keys(patch)) if (key !== 'updated_by') restore[key] = page[key] ?? null
  restore.slug = page.slug
  const undone = await updatePageRow(db, page.id, restore)
  if (undone.ok) return { ok: false, reason: 'retire_failed', error: retiredError }
  return { ok: true, page: saved.page, retired: null, retiredError, rollbackError: undone.error || { message: undone.reason } }
}

/**
 * The page at `id` with its studio rows, when the caller may view it; null
 * otherwise (no such page, not a uuid, or outside the caller's view), so a
 * route answers 404 for all three alike. A failed read throws PageReadError.
 */
export async function loadViewablePage(db, user, id) {
  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) return null
  const loaded = await loadPageById(db, id)
  if (!loaded || !canViewPage(user, loaded.page)) return null
  return loaded
}

/** Does a page in this organisation already hold the slug? A failed read throws PageReadError. */
export async function slugTakenInOrg(db, { orgId, slug }) {
  const { data, error } = await db
    .from('landing_pages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new PageReadError('Could not read the page', error)
  return Boolean(data)
}

/**
 * Save one studio row of a page (by page and location; the caller checked
 * the row is the page's and who may write it).
 * @returns {Promise<{ ok: true, row: object } | { ok: false, reason: 'failed' | 'gone', error?: object }>}
 */
export async function saveStudioRow(db, { pageId, locationId, patch }) {
  const { data, error } = await db
    .from('landing_page_studios')
    .update(patch)
    .eq('page_id', pageId)
    .eq('location_id', locationId)
    .select('page_id, location_id, enabled, offer, attribution, sort_order')
    .maybeSingle()
  if (error) return { ok: false, reason: 'failed', error }
  if (!data) return { ok: false, reason: 'gone' }
  return { ok: true, row: data }
}

/**
 * The kind='studio' pages of an organisation for a set of locations, as a Map
 * of location id to { id, chrome, publish_state } (a location with no studio
 * page is absent). Scoped by the organisation, so another tenant's studio can
 * never come back. The chooser's tile routes read through it. A failed read
 * throws PageReadError.
 */
export async function loadStudioPagesByLocation(db, { orgId, locationIds }) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await db
    .from('landing_pages')
    .select('id, primary_location_id, chrome, publish_state')
    .eq('kind', 'studio')
    .eq('organization_id', orgId)
    .in('primary_location_id', ids)
  if (error) throw new PageReadError('Could not read the studio pages', error)
  return new Map((data || []).map((r) => [r.primary_location_id, r]))
}

/**
 * Write columns onto one page row (by id, inside the organisation).
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'failed' | 'gone', error?: object }>}
 */
export async function savePageFields(db, { orgId, pageId, patch }) {
  const { data, error } = await db
    .from('landing_pages')
    .update(patch)
    .eq('id', pageId)
    .eq('organization_id', orgId)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, reason: 'failed', error }
  if (!data) return { ok: false, reason: 'gone' }
  return { ok: true }
}

// The slug a new studio's page starts at: the location name's slug, trimmed so
// that the numeric suffix still fits the 40-character limit.
function studioSlugCandidate(base, n) {
  if (n === 1) return base
  const suffix = `-${n}`
  return `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`
}

const STUDIO_SLUG_ATTEMPTS = 50

/**
 * A new location's studio page (R7): a draft kind='studio' page, slug the
 * location name's slug made unique in the organisation (-2, -3, ... when the
 * slug is taken or reserved), the default blocks, no offer, and its one studio
 * row switched on. Every read happens before the first write; a studio-row
 * insert that fails removes the page again (the studio page never exists
 * without its row).
 *
 * `skipped` answers are not failures: 'no_organization' (nothing to scope the
 * slug by) and 'no_slug' (the name yields no valid slug: a slug of fewer than
 * two characters, or none free within 50 tries). The caller logs and warns.
 * A failed read throws PageReadError.
 * @returns {Promise<{ ok: true, page: object } | { ok: false, reason: 'no_organization' | 'no_slug' | 'failed', error?: object }>}
 */
export async function createStudioPageForLocation(db, { location, userId }) {
  const orgId = location?.organization_id
  if (!orgId || !location?.id) return { ok: false, reason: 'no_organization' }
  const base = normaliseSlug(toSlug(location.name || ''))
  if (!base) return { ok: false, reason: 'no_slug' }

  let slug = null
  for (let n = 1; n <= STUDIO_SLUG_ATTEMPTS; n += 1) {
    const candidate = studioSlugCandidate(base, n)
    if (slugProblem(candidate)) continue
    if (!(await slugTakenInOrg(db, { orgId, slug: candidate }))) { slug = candidate; break }
  }
  if (!slug) return { ok: false, reason: 'no_slug' }

  const { data: page, error: pageErr } = await db
    .from('landing_pages')
    .insert({
      organization_id: orgId,
      slug,
      title: location.name,
      kind: 'studio',
      scope: 'one',
      primary_location_id: location.id,
      offer_type: 'none',
      blocks: defaultBlocks(),
      chrome: { tone: 'dark', noindex: false, show_instagram_feed: true },
      publish_state: 'draft',
      created_by: userId ?? null,
      updated_by: userId ?? null,
    })
    .select(PAGE_COLUMNS)
    .single()
  if (pageErr || !page) return { ok: false, reason: 'failed', error: pageErr }

  const { error: rowErr } = await db.from('landing_page_studios').insert({
    page_id: page.id,
    location_id: location.id,
    enabled: true,
    offer: {},
    attribution: {},
    sort_order: 0,
    updated_by: userId ?? null,
  })
  if (rowErr) {
    const { error: undoErr } = await db.from('landing_pages').delete().eq('id', page.id)
    if (undoErr) logError('landing-pages', 'new studio page without its studio row could not be removed', { pageId: page.id, code: undoErr.code ?? null })
    return { ok: false, reason: 'failed', error: rowErr }
  }
  return { ok: true, page }
}

/**
 * A studio added to an organisation gets a switched-off row on every
 * scope='all' page of that organisation that has none for it yet (spec §1:
 * the editor shows it as "not yet set up"), sort_order after the page's last.
 * Reads before writing; a failed read throws PageReadError.
 * @returns {Promise<{ ok: true, added: number } | { ok: false, error: object }>}
 */
export async function addStudioToOrgPages(db, { orgId, locationId, userId = null }) {
  const { data: pages, error: pagesErr } = await db
    .from('landing_pages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('scope', 'all')
  if (pagesErr) throw new PageReadError('Could not read the organisation\'s pages', pagesErr)
  const ids = (pages || []).map((p) => p.id)
  if (!ids.length) return { ok: true, added: 0 }

  const { data: existing, error: rowsErr } = await db
    .from('landing_page_studios')
    .select('page_id, location_id, sort_order')
    .in('page_id', ids)
  if (rowsErr) throw new PageReadError('Could not read the pages\' studios', rowsErr)
  const max = new Map(ids.map((id) => [id, -1]))
  const has = new Set()
  for (const r of existing || []) {
    max.set(r.page_id, Math.max(max.get(r.page_id) ?? -1, Number(r.sort_order) || 0))
    if (r.location_id === locationId) has.add(r.page_id)
  }
  const rows = ids.filter((id) => !has.has(id)).map((id) => ({
    page_id: id,
    location_id: locationId,
    enabled: false,
    offer: {},
    attribution: {},
    sort_order: max.get(id) + 1,
    updated_by: userId,
  }))
  if (!rows.length) return { ok: true, added: 0 }
  const { error } = await db.from('landing_page_studios').insert(rows)
  if (error) return { ok: false, error }
  return { ok: true, added: rows.length }
}
