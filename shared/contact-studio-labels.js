// CARDLENS-M.3 — the short studio names the contact screens tag rows with
// (a deal, a note, a WhatsApp thread, a booking), on the web and the phone.
// Pure, no imports, so the server, the web and the staff app all read it.
//
// Same rule as the web contact page's studioNameMap (CARDLENS.2): nothing for
// a person with fewer than two studios (no noise for the ~99% who have one),
// and the brand word the names share is dropped ("UN1T Hatch Street" and
// "UN1T Stillorgan" tag as "Hatch Street" and "Stillorgan").

/**
 * @param {Array<{ location_id?: string, location?: { name?: string|null } | null }>} rows
 *   contact_studios rows with their location (loadContactStudios)
 * @returns {Record<string, string>} location id → short name; {} under two studios
 */
export function studioTagNames(rows) {
  const byId = new Map()
  for (const r of rows || []) {
    const name = String(r?.location?.name || '').trim()
    if (r?.location_id && name && !byId.has(r.location_id)) byId.set(r.location_id, name)
  }
  if (byId.size < 2) return {}
  const words = [...byId.values()].map((n) => n.split(/\s+/))
  const first = words[0][0]
  const strip = words.every((w) => w.length > 1 && w[0] === first)
  const out = {}
  for (const [id, name] of byId) out[id] = strip ? name.split(/\s+/).slice(1).join(' ') : name
  return out
}

/**
 * The tag for one row, or null (one studio, an unknown studio, no location).
 * @param {Record<string, string>|null|undefined} tags studioTagNames' result
 * @param {string|null|undefined} locationId
 * @returns {string|null}
 */
export function studioTagFor(tags, locationId) {
  if (!tags || !locationId) return null
  const name = tags[locationId]
  return typeof name === 'string' && name ? name : null
}
