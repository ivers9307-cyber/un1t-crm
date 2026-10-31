// PAGES.1 — the pure decisions behind the one public page route
// (src/app/(public)/[slug]/[[...rest]]/page.js): which layout a page's offer
// type takes, where a retired page sends its visitor, and what a sub-path
// under a page slug means. No IO, no React. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md (§2, §4).

import { normaliseSlug } from '@/lib/page-slug'

const LAYOUT_BY_OFFER = Object.freeze({
  paid_trial: 'frosted',
  class_funnel: 'frosted',
  promo_credits: 'frosted',
  one_class: 'one_class',
  none: 'blocks',
})

/**
 * The layout for an offer type: 'frosted' | 'one_class' | 'blocks' (anything
 * unknown is 'blocks'). A studio page is always 'blocks', whatever its offer:
 * TRIALFIRST puts a paid trial's card in the page's own hero instead.
 */
export function layoutFor(offerType, kind = 'campaign') {
  if (kind === 'studio') return 'blocks'
  return (typeof offerType === 'string' && Object.hasOwn(LAYOUT_BY_OFFER, offerType)) ? LAYOUT_BY_OFFER[offerType] : 'blocks'
}

// The visitor's query as URLSearchParams, from what Next hands a page (a plain
// object, an array value repeating its key) or a URLSearchParams.
function queryOf(searchParams) {
  const out = new URLSearchParams()
  if (searchParams instanceof URLSearchParams) {
    for (const [k, v] of searchParams) out.append(k, v)
  } else if (searchParams && typeof searchParams === 'object') {
    for (const [k, v] of Object.entries(searchParams)) {
      if (Array.isArray(v)) v.forEach((item) => out.append(k, String(item)))
      else if (v !== undefined && v !== null) out.append(k, String(v))
    }
  }
  return out
}

// A path on the same host: one leading slash, never `//host` or `/\host`
// (both are read as another origin by a browser).
const isLocalPath = (s) => typeof s === 'string' && s.startsWith('/') && !s.startsWith('//') && !s.includes('\\')

/**
 * Where a retired page sends its visitor: its `redirect_to` with the
 * original query string appended (an ad's utm_* and fbclid survive). A
 * one-segment sub-path that names a studio picks that studio
 * (/start/hatch-street goes to /trial?studio=hatch-street, as the old
 * /start/<studio> route did); any other sub-path is dropped. An incoming key
 * the target already sets (or the studio the path chose) is dropped from the
 * visitor's query: a second `studio` reads as an array and shows the picker.
 * null when the page has no same-host target, which the route answers with a
 * 404.
 *
 * `studioFromSegment` maps a segment to a studio's public path, or null (the
 * route passes studioParamToPublicPath); this module stays pure.
 */
export function redirectTarget(page, rest, searchParams, { studioFromSegment = null } = {}) {
  const raw = typeof page?.redirect_to === 'string' ? page.redirect_to.trim() : ''
  if (!isLocalPath(raw)) return null
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  const beforeHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const qAt = beforeHash.indexOf('?')
  const path = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash
  const out = new URLSearchParams(qAt >= 0 ? beforeHash.slice(qAt + 1) : '')

  const segments = Array.isArray(rest) ? rest : []
  const pathStudio = segments.length === 1 && typeof studioFromSegment === 'function' ? studioFromSegment(segments[0]) : null
  if (pathStudio) out.set('studio', pathStudio)

  const taken = new Set(out.keys())
  const incoming = queryOf(searchParams)
  for (const [k, v] of incoming) if (!taken.has(k)) out.append(k, v)

  const qs = out.toString()
  return `${path}${qs ? `?${qs}` : ''}${hash}`
}

// The sub-pages a studio page serves under its slug (/stillorgan/events).
const STUDIO_SUBPAGES = Object.freeze(['events', 'status'])

/**
 * What the part after the slug means. A promo_credits page takes exactly one
 * segment, the promo key (/corp/hatch-3-free). A studio page takes exactly
 * one segment, `events` or `status` (the old /welcome/<path>/events and
 * /status). Anything else is unknown (the route 404s it).
 * @returns {{ kind: 'root' } | { kind: 'promo', key: string } | { kind: 'events' } | { kind: 'status' } | { kind: 'unknown' }}
 */
export function pageSubpath(page, rest) {
  const segments = Array.isArray(rest) ? rest : []
  if (segments.length === 0) return { kind: 'root' }
  if (page?.kind === 'studio') {
    return segments.length === 1 && STUDIO_SUBPAGES.includes(segments[0]) ? { kind: segments[0] } : { kind: 'unknown' }
  }
  if (page?.offer_type === 'promo_credits' && segments.length === 1 && typeof segments[0] === 'string' && segments[0]) {
    return { kind: 'promo', key: segments[0] }
  }
  return { kind: 'unknown' }
}

/**
 * Where an old /welcome/<path> link goes now: /<path>, or /<path>/events and
 * /<path>/status for the two sub-pages, with the visitor's query string kept
 * as it came (an ad's utm_*, a checkout's ?purchase=, the editor's ?edit=1).
 * null when the path is not a slug or the sub-page is not one of the two, so
 * the caller answers 404 and never redirects off the host.
 */
export function legacyStudioRedirect(location, sub, searchParams) {
  const slug = normaliseSlug(location)
  if (!slug) return null
  if (sub != null && !STUDIO_SUBPAGES.includes(sub)) return null
  const qs = queryOf(searchParams).toString()
  return `/${slug}${sub ? `/${sub}` : ''}${qs ? `?${qs}` : ''}`
}
