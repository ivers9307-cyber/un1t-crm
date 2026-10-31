// PAGES.1 — the pure decisions behind the one public page route
// (src/app/(public)/[slug]/[[...rest]]/page.js): which layout a page's offer
// type takes, where a retired page sends its visitor, and what a sub-path
// under a page slug means. No IO, no React. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md (§2, §4).

const LAYOUT_BY_OFFER = Object.freeze({
  paid_trial: 'frosted',
  class_funnel: 'frosted',
  promo_credits: 'frosted',
  one_class: 'one_class',
  none: 'blocks',
})

/** The layout for an offer type: 'frosted' | 'one_class' | 'blocks' (anything unknown is 'blocks'). */
export function layoutFor(offerType) {
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
 * original query string appended (an ad's utm_* and fbclid survive), the
 * sub-path dropped (/start/hatch-street goes where /start goes). null when the
 * page has no same-host target, which the route answers with a 404.
 */
export function redirectTarget(page, _rest, searchParams) {
  const base = typeof page?.redirect_to === 'string' ? page.redirect_to.trim() : ''
  if (!isLocalPath(base)) return null
  const qs = queryOf(searchParams).toString()
  if (!qs) return base
  const joiner = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?'
  return `${base}${joiner}${qs}`
}

/**
 * What the part after the slug means. A promo_credits page takes exactly one
 * segment, the promo key (/corp/hatch-3-free). A studio page's `events` and
 * `status` arrive in PR3; until then they, and everything else, are unknown
 * (the route 404s them).
 * @returns {{ kind: 'root' } | { kind: 'promo', key: string } | { kind: 'unknown' }}
 */
export function pageSubpath(page, rest) {
  const segments = Array.isArray(rest) ? rest : []
  if (segments.length === 0) return { kind: 'root' }
  if (page?.offer_type === 'promo_credits' && segments.length === 1 && typeof segments[0] === 'string' && segments[0]) {
    return { kind: 'promo', key: segments[0] }
  }
  return { kind: 'unknown' }
}
