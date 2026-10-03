// METADATASET.1 — a location's own Meta dataset (pixel) for website
// conversions, and the token that may post events to it.
//
// Until now `settings.meta_ads.dataset_id` could only be set by hand in SQL,
// and the Conversions API call borrowed the location's WhatsApp number token.
// That works for Stillorgan (one business owns its WhatsApp account, its ad
// account and its dataset). Hatch Street's ad account and dataset live in a
// separate Meta business and the studio has no WhatsApp number, so its
// booking funnel could tell Meta nothing: no Lead event ever fired.
//
// Both values live under `locations.settings.meta_ads`:
//   dataset_id         the dataset the events go to
//   capi_access_token  a token generated FOR that dataset in Events Manager.
//                      Optional: when absent the WhatsApp number token is
//                      used, which is today's behaviour everywhere.
// The token's key ends in `token`, so the audit trigger (mig 647) and
// redactLocationSecrets mask it without being told (src/lib/secret-keys.js).
//
// Pure: no DB, no network.
import { isFreshSecret } from './integration-secret-merge.js'

/** Digits only, 5 to 25 of them; anything else is "no dataset". */
export function normalizeDatasetId(value) {
  const s = String(value ?? '').trim()
  return /^\d{5,25}$/.test(s) ? s : ''
}

/** What a settings screen may know: the dataset id, and WHETHER a token is stored. */
export function conversionsView(settings) {
  const m = settings?.meta_ads
  const token = typeof m?.capi_access_token === 'string' ? m.capi_access_token.trim() : ''
  return { dataset_id: normalizeDatasetId(m?.dataset_id), has_token: token !== '' }
}

/**
 * The token to post a website event with: the dataset's own token when one is
 * stored, otherwise the fallback (the location's WhatsApp number token).
 */
export function websiteEventToken(settings, fallbackToken) {
  const own = typeof settings?.meta_ads?.capi_access_token === 'string' ? settings.meta_ads.capi_access_token.trim() : ''
  if (own) return own
  return typeof fallbackToken === 'string' && fallbackToken.trim() ? fallbackToken.trim() : null
}

/**
 * Apply a settings-form save to the WHOLE settings object and return the next
 * one. Every other key, and every other key inside meta_ads, is carried over.
 *   dataset_id         set when given; blank clears it (turns the events off)
 *   capi_access_token  a blank or masked value KEEPS the stored token; only a
 *                      real new value replaces it; `clear_token: true` removes it
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
export function mergeConversionsSettings(settings, patch) {
  const base = settings && typeof settings === 'object' ? settings : {}
  const current = base.meta_ads && typeof base.meta_ads === 'object' ? base.meta_ads : {}
  const next = { ...current }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'dataset_id')) {
    const raw = String(patch.dataset_id ?? '').trim()
    const id = normalizeDatasetId(raw)
    if (raw && !id) return { ok: false, error: 'The dataset ID is the number shown in Meta Events Manager (digits only).' }
    if (id) next.dataset_id = id
    else delete next.dataset_id
  }
  if (patch?.clear_token === true) delete next.capi_access_token
  else if (isFreshSecret(patch?.capi_access_token)) next.capi_access_token = String(patch.capi_access_token).trim()
  return { ok: true, settings: { ...base, meta_ads: next } }
}
