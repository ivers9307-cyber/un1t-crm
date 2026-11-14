// FIFTYPLUS.1 — the ad-attribution plumbing a campaign page (/50plus) shares
// with the class funnel, lifted as pure functions so CampaignFunnel does not
// copy ClassFunnel's closures. Client-safe, no IO: the component reads the
// URL, the cookie and sessionStorage and hands them in.
//
// Same rules as ClassFunnel (ADS-REPORT.2, METADATASET.1, MATCHQUALITY.1):
// an ad signal (meta_ad_id, utm_*, fbclid) makes the lead a Meta ad lead;
// the Pixel's browser id (_fbp) is sent for organic visitors too, because it
// raises the server Lead's match quality and makes nobody an ad lead.

// TRIALLEAK.1 — utm_source / utm_medium ride along for measurement (which
// placement, which medium). They are NOT an ad signal: on their own they make
// nobody a Meta ad lead.
const AD_PARAMS = ['utm_campaign', 'utm_content', 'utm_term', 'utm_source', 'utm_medium', 'meta_ad_id', 'fbclid']

/** The attribution keys that carry an ad's URL parameter (and so may carry an unfilled macro). */
export const AD_VALUE_KEYS = Object.freeze(['utm_campaign', 'utm_content', 'utm_term', 'utm_source', 'utm_medium', 'meta_ad_id', 'ad_id', 'ad_external_id'])

/**
 * TRIALLEAK.1 — an ad's URL parameters are macros (`{{ad.id}}`,
 * `{{adset.id}}`, `{{campaign.name}}`). Meta leaves them unfilled when the
 * ad's post is seen organically, and the literal text was being stored as if
 * it were a campaign. A value that still holds `{{ … }}` (or its URL-encoded
 * form) is no value at all.
 */
export function isUnfilledAdMacro(value) {
  if (typeof value !== 'string') return false
  const v = value.replace(/%7B/gi, '{').replace(/%7D/gi, '}')
  return /\{\{[^]*\}\}/.test(v)
}

/** The value, or undefined when it is empty or an unfilled macro. */
export function cleanAdValue(value) {
  if (value == null || value === '') return undefined
  return isUnfilledAdMacro(String(value)) ? undefined : value
}

/** A copy of an attribution object with every unfilled-macro ad value removed. */
export function cleanAttribution(attribution) {
  if (!attribution || typeof attribution !== 'object') return attribution
  const out = { ...attribution }
  for (const k of AD_VALUE_KEYS) if (k in out && cleanAdValue(out[k]) === undefined) delete out[k]
  return out
}

/** The ad params off a landing URL's search string. Absent ones (and unfilled macros) are undefined. */
export function readAttributionFromUrl(search) {
  const p = new URLSearchParams(typeof search === 'string' ? search : '')
  const out = {}
  for (const k of AD_PARAMS) out[k] = cleanAdValue(p.get(k) || undefined)
  // The trial page's older links name the ad `ad_id`.
  if (!out.meta_ad_id) out.meta_ad_id = cleanAdValue(p.get('ad_id') || undefined)
  return out
}

/** What the booking POST sends as `attribution`, or undefined when there is nothing to say. */
export function buildAttribution(raw, fbp) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const hasSignal = p.meta_ad_id || p.utm_campaign || p.utm_content || p.utm_term || p.fbclid
  if (!hasSignal && !fbp && !p.utm_source && !p.utm_medium) return undefined
  return {
    ...(hasSignal ? {
      utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term,
      ad_provider: 'meta', ad_external_id: p.meta_ad_id,
      fbclid: p.fbclid,
    } : {}),
    ...(p.utm_source ? { utm_source: p.utm_source } : {}),
    ...(p.utm_medium ? { utm_medium: p.utm_medium } : {}),
    ...(fbp ? { fbp } : {}),
  }
}

/** The Pixel's browser id cookie, when consent let it set; null otherwise. */
export function readFbpCookie(cookie) {
  try {
    const m = String(cookie || '').match(/(?:^|;\s*)_fbp=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

const SESSION_KEY = 'campaign_sid'

/** A stable per-visit id so a visitor's funnel steps group into one journey. Storage may throw (private mode). */
export function funnelSessionId(storage) {
  let sid = null
  try { sid = storage?.getItem(SESSION_KEY) || null } catch { /* private mode */ }
  if (!sid) {
    sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try { storage?.setItem(SESSION_KEY, sid) } catch { /* private mode */ }
  }
  return sid
}
