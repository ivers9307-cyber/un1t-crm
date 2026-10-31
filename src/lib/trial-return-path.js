// TRIALFIRST.1 — where a paid-trial buyer lands after a redirect-based payment
// (Revolut 3DS at Stillorgan, un1t.online's hosted checkout at Hatch Street).
// The purchase POST takes the page the buyer started on, but only from this
// closed list: the value ends up in a redirect URL, so a free-form path would
// be an open redirect. Pure module (its one import is the pure slug rule).

// PAGES.1 — the list is /trial plus `/<slug>` of every live studio page of the
// host's organisation, read server-side per request (listStudioPageSlugs) and
// handed in, so this module stays pure. A slug is shape-checked again here
// (SLUG_RE: no slash, dot or query), so a bad row could never make a redirect
// target that leaves the site.
import { SLUG_RE } from '@/lib/page-slug'

export function trialReturnPaths(slugs = []) {
  const paths = ['/trial']
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    if (typeof slug === 'string' && SLUG_RE.test(slug) && !paths.includes(`/${slug}`)) paths.push(`/${slug}`)
  }
  return paths
}

// Exact match against the list; anything else (query strings, trailing slashes,
// absolute URLs, non-strings) is /trial.
export function normalizeTrialReturnPath(value, { slugs = [] } = {}) {
  return typeof value === 'string' && trialReturnPaths(slugs).includes(value) ? value : '/trial'
}

// A studio page's `slug` (its public path) -> the path its buyers return to.
export function trialReturnPathFor(publicPath) {
  return typeof publicPath === 'string' && publicPath ? `/${publicPath}` : '/trial'
}

// What a page reads off its search params when a buyer comes back from the
// checkout: the purchase to resume, which studio it was, and whether they
// backed out (`cancelled=1`).
export function parseTrialReturn(searchParams) {
  const sp = searchParams || {}
  return {
    resumePurchaseId: typeof sp.purchase === 'string' && /^[0-9a-f-]{36}$/i.test(sp.purchase) ? sp.purchase : null,
    initialStudio: ['stillorgan', 'hatch'].includes(sp.studio) ? sp.studio : null,
    cancelled: sp.cancelled === '1',
  }
}
