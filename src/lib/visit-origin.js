// VISIT-ORIGIN.1 — where a public-site visitor came from, without a
// tracking cookie.
//
// Ad clicks are attributed from URL params (utm_* + fbclid, ADS-REPORT.2 /
// METADATASET.1). Everyone else — the website's own pages, Google, the
// Instagram bio link, a shared link — arrived with no params and looked
// identical. This module remembers the FIRST page of the visit and its
// referrer in sessionStorage (per tab, gone when the tab closes, no
// consent-banner implication: it is a session value, not a tracking
// cookie), the two public forms send it with the submission, and the
// routes stamp it on the contact once (stamp-if-null = first touch).
//
// Browser helpers and pure helpers live together so the forms, the routes
// and the UI share one definition. Nothing here imports a server module.

export const VISIT_ORIGIN_KEY = 'un1t_visit_origin'

const MAX_REFERRER = 300
const MAX_PATH = 200

/**
 * Browser: remember the first page of this visit. No-op after the first
 * call in a tab (sessionStorage already holds it), and on any storage
 * failure (private mode, quota, disabled) — the forms simply send nothing.
 */
export function rememberVisitOrigin() {
  if (typeof window === 'undefined') return
  try {
    if (window.sessionStorage.getItem(VISIT_ORIGIN_KEY)) return
    const landing_path = `${window.location.pathname || '/'}`
    const referrer = typeof document !== 'undefined' ? (document.referrer || '') : ''
    window.sessionStorage.setItem(VISIT_ORIGIN_KEY, JSON.stringify({ referrer, landing_path }))
  } catch { /* storage unavailable: nothing to remember */ }
}

/**
 * Browser: what rememberVisitOrigin stored, or null. Returned raw: the
 * server sanitises, never the client.
 */
export function readVisitOrigin() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(VISIT_ORIGIN_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    return {
      referrer: typeof v.referrer === 'string' ? v.referrer : '',
      landing_path: typeof v.landing_path === 'string' ? v.landing_path : '',
    }
  } catch { return null }
}

/**
 * Server: reduce the client's low-trust values to what gets stored.
 *  - referrer: must parse as an http(s) URL; stored as origin + pathname
 *    (query and fragment dropped — a referrer's query can carry someone
 *    else's tokens), lower-cased host, capped.
 *  - landing_path: must be an absolute path on our site ('/…'), query and
 *    fragment dropped (the utm_* params are already captured separately),
 *    capped.
 * Returns null when neither survives.
 */
export function sanitiseVisitOrigin(input) {
  if (!input || typeof input !== 'object') return null
  let referrer = null
  if (typeof input.referrer === 'string' && input.referrer.trim()) {
    try {
      const u = new URL(input.referrer.trim())
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        referrer = `${u.protocol}//${u.host.toLowerCase()}${u.pathname === '/' ? '' : u.pathname}`.slice(0, MAX_REFERRER)
      }
    } catch { /* not a URL: dropped */ }
  }
  let landing_path = null
  if (typeof input.landing_path === 'string') {
    const p = input.landing_path.trim().split(/[?#]/)[0]
    if (p.startsWith('/') && !p.startsWith('//')) landing_path = p.slice(0, MAX_PATH)
  }
  if (!referrer && !landing_path) return null
  return { referrer, landing_path }
}

// Hosts that count as "our website" — a referrer here means the visitor
// moved between our own pages; the landing path is what tells the story.
const OWN_HOSTS = ['un1tdublin.com', 'repset.ie', 'un1t.online', 'localhost']

const KNOWN = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'Facebook'],
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
  [/(^|\.)strava\.com$/, 'Strava'],
]

function hostOf(referrer) {
  try { return new URL(referrer).host.toLowerCase().replace(/^www\./, '') } catch { return null }
}

/**
 * One short, operator-facing line for a contact: "Meta ad", "Instagram",
 * "Google", "Website, landed on /hatch-street", "Direct link to
 * /start/hatch-street", or null when nothing is known at all. An ad
 * attribution wins over the referrer: the referrer of an ad click is
 * Facebook/Instagram anyway and the ad is the more specific answer.
 */
export function visitOriginLabel(contact) {
  if (!contact || typeof contact !== 'object') return null
  if (contact.ad_provider === 'meta') {
    return contact.utm_content ? `Meta ad (${contact.utm_content})` : 'Meta ad'
  }
  const referrer = typeof contact.visit_referrer === 'string' ? contact.visit_referrer : ''
  const landing = typeof contact.visit_landing_path === 'string' ? contact.visit_landing_path : ''
  const landedOn = landing ? `landed on ${landing}` : ''
  const host = referrer ? hostOf(referrer) : null
  if (host) {
    if (OWN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return landedOn ? `Website, ${landedOn}` : 'Website'
    }
    for (const [re, name] of KNOWN) {
      if (re.test(host)) return landedOn ? `${name}, ${landedOn}` : name
    }
    return landedOn ? `${host}, ${landedOn}` : host
  }
  if (landing) return `Direct link to ${landing}`
  return null
}
