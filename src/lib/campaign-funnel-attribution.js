// FIFTYPLUS.1 — the ad-attribution plumbing a campaign page (/50plus) shares
// with the class funnel, lifted as pure functions so CampaignFunnel does not
// copy ClassFunnel's closures. Client-safe, no IO: the component reads the
// URL, the cookie and sessionStorage and hands them in.
//
// Same rules as ClassFunnel (ADS-REPORT.2, METADATASET.1, MATCHQUALITY.1):
// an ad signal (meta_ad_id, utm_*, fbclid) makes the lead a Meta ad lead;
// the Pixel's browser id (_fbp) is sent for organic visitors too, because it
// raises the server Lead's match quality and makes nobody an ad lead.

const AD_PARAMS = ['utm_campaign', 'utm_content', 'utm_term', 'meta_ad_id', 'fbclid']

/** The ad params off a landing URL's search string. Absent ones are undefined. */
export function readAttributionFromUrl(search) {
  const p = new URLSearchParams(typeof search === 'string' ? search : '')
  const out = {}
  for (const k of AD_PARAMS) out[k] = p.get(k) || undefined
  return out
}

/** What the booking POST sends as `attribution`, or undefined when there is nothing to say. */
export function buildAttribution(raw, fbp) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const hasSignal = p.meta_ad_id || p.utm_campaign || p.utm_content || p.utm_term || p.fbclid
  if (!hasSignal && !fbp) return undefined
  return {
    ...(hasSignal ? {
      utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term,
      ad_provider: 'meta', ad_external_id: p.meta_ad_id,
      fbclid: p.fbclid,
    } : {}),
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
