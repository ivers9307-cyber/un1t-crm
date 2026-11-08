// WAYSIN.5 — a studio's lead-source vocabulary: the values a contact's
// lead_source can be picked from (ContactForm, AudienceBuilder, the board
// builder's lead_source way in).
//
//   defaults  the nine every studio offers (DEFAULT_LEAD_SOURCES, schemas.js)
//   studio    the owner's own list, locations.settings.lead_sources (PUT
//             /api/locations/[id]/lead-sources)
//   seen      every distinct contacts.lead_source / last_lead_source at the
//             studio, so a value a public funnel writes ('corp_promo',
//             'hatch_launch', …) is pickable without anyone typing it
//
// Every value is trimmed and lowercased, then deduped; the defaults come first
// in their own order, then the rest alphabetically. A value keeps the FIRST
// origin it was found under (default, then studio, then seen).
//
// A vocabulary, not a validator: leadSourceSchema accepts any slug, so a value
// typed into the API is never refused for being new. Pure enough for a client
// import (no server-only modules): the readers take the db as an argument.
//
// Service role: the caller has judged access to the studio; every read here is
// pinned to it. A failed read answers { ok: false, error }, never a shorter list.

import { DEFAULT_LEAD_SOURCES } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'

export { DEFAULT_LEAD_SOURCES }

// The display labels the nine have always had in ContactForm / AudienceBuilder.
export const LEAD_SOURCE_LABELS = Object.freeze({
  booking: 'Booking',
  meta: 'Meta (Facebook/Instagram)',
  tiktok: 'TikTok',
  walkin: 'Walk-in',
  referral: 'Referral',
  website: 'Website',
  whatsapp: 'WhatsApp',
  classpass: 'ClassPass',
  other: 'Other',
})

// The label for a value: the nine's own words, the value itself otherwise.
export function leadSourceLabel(value) {
  const v = typeof value === 'string' ? value : ''
  return LEAD_SOURCE_LABELS[v.trim().toLowerCase()] || v
}

// At most this many owner entries (the PUT enforces it; a hand-edited jsonb
// longer than this is cut, not trusted).
export const STUDIO_LEAD_SOURCES_MAX = 50
// A runaway guard on the distinct scan, not a target (the biggest studio has
// ~10k contacts).
const CONTACT_SCAN_CAP = 50000

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

// The owner's list out of a locations.settings object: strings only,
// normalised, deduped, capped.
export function studioLeadSourcesFromSettings(settings) {
  const raw = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.lead_sources : null
  if (!Array.isArray(raw)) return []
  const out = []
  for (const v of raw) {
    const n = norm(v)
    if (n && !out.includes(n)) out.push(n)
    if (out.length >= STUDIO_LEAD_SOURCES_MAX) break
  }
  return out
}

/**
 * Build the vocabulary from its three inputs. Pure.
 * @param {string[]} studio  the owner's list
 * @param {string[]} seen    values found on contacts
 */
export function buildLeadSourceVocabulary(studio = [], seen = []) {
  const origin = new Map()
  for (const v of DEFAULT_LEAD_SOURCES) origin.set(v, 'default')
  for (const v of studio) { const n = norm(v); if (n && !origin.has(n)) origin.set(n, 'studio') }
  for (const v of seen) { const n = norm(v); if (n && !origin.has(n)) origin.set(n, 'seen') }
  const rest = [...origin.keys()].filter((v) => origin.get(v) !== 'default').sort((a, b) => a.localeCompare(b))
  return [...DEFAULT_LEAD_SOURCES, ...rest].map((value) => ({ value, label: leadSourceLabel(value), origin: origin.get(value) }))
}

/**
 * The studio's vocabulary.
 * @param {object} db service-role client
 * @param {string} locationId
 * @returns {Promise<{ ok: true, sources: {value:string,label:string,origin:'default'|'studio'|'seen'}[], studio: string[] } | { ok: false, error: string }>}
 *   `studio` is the owner's list as stored (an entry that is also a default
 *   keeps origin 'default' in `sources`, so read the list from here).
 */
export async function leadSourceVocabulary(db, locationId) {
  if (!locationId) return { ok: false, error: 'A studio is required.' }

  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = no studio list
  if (locErr) return { ok: false, error: locErr.message || String(locErr) }
  const studio = studioLeadSourcesFromSettings(loc?.settings)

  let rows
  try {
    rows = await selectAll((from, to) => db
      .from('contacts')
      .select('id, lead_source, last_lead_source')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, to), { hardCap: CONTACT_SCAN_CAP })
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
  const seen = []
  for (const r of rows) {
    if (r.lead_source != null) seen.push(r.lead_source)
    if (r.last_lead_source != null) seen.push(r.last_lead_source)
  }
  return { ok: true, sources: buildLeadSourceVocabulary(studio, seen), studio }
}
