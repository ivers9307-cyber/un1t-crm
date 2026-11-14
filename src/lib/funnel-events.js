// funnel-events.js — validate/normalize a /start funnel step event for the
// public capture endpoint (/api/public/funnel-event). Pure; the route handles
// location resolution + the DB insert. Low-trust input (public endpoint), so
// every field is allowlisted/capped and an unknown step is rejected.
import { cleanAdValue } from './campaign-funnel-attribution'

export const VALID_STEPS = [
  'view',
  'path_class',
  'path_consult',
  'details',
  'slots_view',
  'booked_class',
  'booked_consult',
  // CONSENTRATE.1 — the cookie banner, funnel 'consent' (see consent-telemetry.js)
  'consent_shown',
  'consent_accept',
  'consent_reject',
  'consent_custom',
]

const cap = (v, n = 200) => (v == null ? null : String(v).slice(0, n))
// TRIALLEAK.1 — an ad value that is still an unfilled Meta macro
// (`{{adset.id}}`) is stored as nothing, not as a campaign of that name.
// cleanAdValue cuts to the same 200 characters first, then tests the cut value.
const adCap = (v) => cleanAdValue(v) ?? null
const cleanMeta = (meta) => {
  const out = { ...meta }
  for (const k of ['utm_source', 'utm_medium']) {
    if (!(k in out)) continue
    const v = cleanAdValue(out[k])
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

export function parseFunnelEvent(body = {}) {
  if (!VALID_STEPS.includes(body.step)) return null
  const session_id = cap(body.session_id)
  if (!session_id) return null
  const ad_external_id = adCap(body.ad_external_id)
  return {
    funnel: cap(body.funnel) || 'start',
    step: body.step,
    session_id,
    ad_external_id,
    ad_provider: cap(body.ad_provider) || (ad_external_id ? 'meta' : null),
    utm_campaign: adCap(body.utm_campaign),
    utm_content: adCap(body.utm_content),
    utm_term: adCap(body.utm_term),
    meta: body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? cleanMeta(body.meta) : {},
  }
}
