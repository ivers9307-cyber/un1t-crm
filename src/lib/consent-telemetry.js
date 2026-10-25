// consent-telemetry — CONSENTRATE.1: how many visitors accept, reject or
// ignore the cookie banner. The choice itself lives only in the visitor's
// cookie, so nothing server-side could answer "what share accept marketing
// cookies", which caps every browser-side Meta signal. One funnel_events row
// per banner shown and per decision, through the existing public
// funnel-event endpoint (no new table, no PII: just the step and the two
// toggles). Client-only helpers; every path is best-effort.

export const CONSENT_FUNNEL = 'consent'
export const CONSENT_STEPS = ['consent_shown', 'consent_accept', 'consent_reject', 'consent_custom']

/**
 * The landing public_path the endpoint segments by, from the page path:
 * '/hatch-street', '/welcome/hatch-street', '/start/hatch-street' and their
 * sub-pages → 'hatch-street'; anything else → 'stillorgan' (the site default).
 */
export function consentPathFor(pathname) {
  const p = String(pathname || '')
  const m = p.match(/^\/(?:welcome\/|start\/)?([a-z0-9-]+)(?:\/|$)/i)
  const seg = m ? m[1].toLowerCase() : ''
  if (!seg || seg === 'welcome' || seg === 'start') return 'stillorgan'
  return seg
}

/** Fire-and-forget. `detail` is the toggle state for a custom save. */
export function reportConsent(step, detail = {}, { fetchFn, pathname } = {}) {
  if (!CONSENT_STEPS.includes(step)) return false
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null)
  if (!f) return false
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '')
  let session_id = null
  try { session_id = crypto.randomUUID() } catch { session_id = `c-${Date.now()}` }
  try {
    f('/api/public/funnel-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        location_path: consentPathFor(path),
        funnel: CONSENT_FUNNEL,
        step,
        session_id,
        meta: { analytics: !!detail.analytics, marketing: !!detail.marketing, page: String(path).slice(0, 120) },
      }),
    }).catch(() => {})
    return true
  } catch { return false }
}
