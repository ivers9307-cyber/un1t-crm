// HOSTSTATS.1 — where an event-page visitor came from, without a cookie.
//
// The browser half remembers the FIRST touch of the tab (utm_*, the `hc`
// host-campaign id, the referrer, and a random session id) in sessionStorage
// — per tab, gone when it closes, no consent-banner implication (the
// VISIT-ORIGIN.1 argument). The signup widget sends it with the page-view
// beacon and again with the registration; `/h/<slug>` captures it too, so a
// booking that went host page → event page keeps the campaign that sent it.
//
// The server half reduces those low-trust strings to what is stored, and
// derives ONE `source` word per visit: `host_email` (a host campaign link),
// else the utm_source, else the referrer's known label or host, else
// `direct`. Browser helpers and pure helpers live together so the widget,
// the routes and the stats card share one definition; nothing here imports
// a server module.

import { uuidLike } from '@/lib/schemas'

export const EVENT_ATTRIBUTION_KEY = 'un1t_event_attribution'

const STORED_CAP = 300
const UTM_CAP = 120
const SOURCE_CAP = 40
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']

function newSessionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  let s = ''
  while (s.length < 16) s += Math.random().toString(36).slice(2)
  return s.slice(0, 16)
}

/**
 * Browser: remember the first touch of this tab. No-op after the first call
 * (sessionStorage already holds it) and on any storage failure.
 */
export function rememberEventAttribution({ search, referrer } = {}) {
  if (typeof window === 'undefined') return
  try {
    if (window.sessionStorage.getItem(EVENT_ATTRIBUTION_KEY)) return
    const qs = new URLSearchParams(search ?? window.location.search ?? '')
    const ref = referrer ?? (typeof document !== 'undefined' ? document.referrer || '' : '')
    const cap = (v) => (typeof v === 'string' && v ? v.slice(0, STORED_CAP) : null)
    const stored = { session_id: newSessionId(), referrer: cap(ref), hc: cap(qs.get('hc')) }
    for (const k of UTM_KEYS) stored[k] = cap(qs.get(k))
    window.sessionStorage.setItem(EVENT_ATTRIBUTION_KEY, JSON.stringify(stored))
  } catch { /* storage unavailable: nothing to remember */ }
}

/** Browser: what rememberEventAttribution stored, or null. Raw: the server sanitises. */
export function readEventAttribution() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(EVENT_ATTRIBUTION_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

const KNOWN_HOSTS = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'facebook'],
  [/(^|\.)google\./, 'google'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)strava\.com$/, 'strava'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'x'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
]

/** The known social/search hosts → one word; any other host → itself. */
export function referrerSourceLabel(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return null
  for (const [re, label] of KNOWN_HOSTS) if (re.test(h)) return label
  return h
}

// Words only the SERVER derives. A utm_source spelling one of them is a
// visitor posing as a host-email conversion (or hiding as direct) and is
// skipped, so the two namespaces stay disjoint.
const RESERVED_SOURCES = new Set(['host_email', 'direct', 'unknown'])

/** One source word: campaign → utm_source → referrer → direct. */
// A utm_source becomes a source word only as a plain token: it is shown on
// the host's and staff's card, and the beacon is unauthenticated, so free
// text there would be attacker-authored copy on an operator screen.
const SOURCE_TOKEN = /^[a-z0-9][a-z0-9_.-]{0,39}$/

export function sourceOf({ host_campaign_id, utm_source, referrer_host }) {
  if (host_campaign_id) return 'host_email'
  if (utm_source) {
    const u = String(utm_source).trim().toLowerCase()
    if (u.length <= SOURCE_CAP && SOURCE_TOKEN.test(u) && !RESERVED_SOURCES.has(u)) return u
  }
  if (referrer_host) return referrerSourceLabel(referrer_host)
  return 'direct'
}

const LABELS = {
  host_email: 'Host email', direct: 'Direct', unknown: 'Unknown', other: 'Other',
  instagram: 'Instagram', facebook: 'Facebook', google: 'Google', whatsapp: 'WhatsApp',
  strava: 'Strava', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube',
}

/** Operator-facing label for a source word. (Not `sourceLabel`: shared/format.js owns that name.) */
export function attributionSourceLabel(source) {
  const s = String(source || '')
  return LABELS[s] || s
}

/**
 * Server: reduce the client's values to what gets stored. Returns null when
 * the input is not an object at all; otherwise every field is present
 * (null when unusable) and `source` is always a word.
 */
export function sanitiseEventAttribution(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const str = (v, cap) => {
    if (typeof v !== 'string') return null
    const t = v.trim().slice(0, cap)
    return t || null
  }
  const session_id = typeof input.session_id === 'string' && SESSION_ID_RE.test(input.session_id) ? input.session_id : null
  const host_campaign_id = typeof input.hc === 'string' && uuidLike.safeParse(input.hc).success ? input.hc : null
  let referrer_host = null
  if (typeof input.referrer === 'string' && input.referrer.trim()) {
    try {
      const u = new URL(input.referrer.trim())
      if (u.protocol === 'http:' || u.protocol === 'https:') referrer_host = u.host.toLowerCase().replace(/^www\./, '').slice(0, UTM_CAP) || null
    } catch { /* not a URL: dropped */ }
  }
  const out = { session_id, host_campaign_id, referrer_host }
  for (const k of UTM_KEYS) out[k] = str(input[k], UTM_CAP)
  out.source = sourceOf(out)
  return out
}
