// TRIALFIRST.1 — where a paid-trial buyer lands after a redirect-based payment
// (Revolut 3DS at Stillorgan, un1t.online's hosted checkout at Hatch Street).
// The purchase POST takes the page the buyer started on, but only from this
// closed list: the value ends up in a redirect URL, so a free-form path would
// be an open redirect. Pure module, no imports.

export const TRIAL_RETURN_PATHS = Object.freeze(['/trial', '/stillorgan', '/hatch-street'])

// Exact match against the list; anything else (query strings, trailing slashes,
// absolute URLs, non-strings) is /trial.
export function normalizeTrialReturnPath(value) {
  return typeof value === 'string' && TRIAL_RETURN_PATHS.includes(value) ? value : '/trial'
}

// A studio page's landing `public_path` -> the path its buyers return to.
export function trialReturnPathFor(publicPath) {
  if (publicPath === 'stillorgan') return '/stillorgan'
  if (publicPath === 'hatch-street') return '/hatch-street'
  return '/trial'
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
