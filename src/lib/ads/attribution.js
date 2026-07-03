// Join ad spend to CRM bookings attributed to each ad via contacts.ad_external_id.

export function computeCostPerBooking(spendByAd, bookingsByAd) {
  const out = {}
  const ids = new Set([...Object.keys(spendByAd), ...Object.keys(bookingsByAd)])
  for (const id of ids) {
    const spend = Number(spendByAd[id] || 0)
    const bookings = Number(bookingsByAd[id] || 0)
    out[id] = { spend, bookings, cpa: bookings > 0 ? Math.round((spend / bookings) * 100) / 100 : null }
  }
  return out
}

/** Resolve which ad a booking belongs to: prefer the stable ad_external_id;
 *  fall back to matching utm_content (the Meta {{ad.name}}) against ad names.
 *  nameToId maps ad name -> ad external_id (built from ad_entities). */
export function resolveAdId(contact, nameToId = {}) {
  if (!contact) return null
  if (contact.ad_external_id) return String(contact.ad_external_id)
  if (contact.utm_content && nameToId[contact.utm_content]) return String(nameToId[contact.utm_content])
  return null
}

/** Count /start bookings attributed to each ad for a location in [since,until].
 *  A "booking" = a booked class request OR a meta_book consult booking whose
 *  contact carries ad_external_id. Returns { [ad_external_id]: count }. */
export async function loadBookingsByAd(db, locationId, since, until, nameToId = {}) {
  const out = {}
  // Class bookings that reached 'booked'
  const { data: cbr } = await db.from('class_booking_requests')
    .select('contact_id, contacts!inner(ad_external_id, utm_content)')
    .eq('location_id', locationId).eq('status', 'booked')
    .gte('created_at', since).lte('created_at', until + 'T23:59:59')
  for (const r of cbr || []) {
    const id = resolveAdId(r.contacts, nameToId)
    if (id) out[id] = (out[id] || 0) + 1
  }
  // Consult bookings via /start (source='meta_book')
  const { data: bk } = await db.from('bookings')
    .select('contact_id, contacts!inner(ad_external_id, utm_content)')
    .eq('location_id', locationId).eq('source', 'meta_book')
    .gte('booking_date', since).lte('booking_date', until)
  for (const r of bk || []) {
    const id = resolveAdId(r.contacts, nameToId)
    if (id) out[id] = (out[id] || 0) + 1
  }
  return out
}

/** Sum spend per ad from ad_insights_daily for a location in [since,until]. */
export async function loadSpendByAd(db, locationId, since, until) {
  const { data } = await db.from('ad_insights_daily')
    .select('entity_external_id, spend')
    .eq('location_id', locationId).eq('level', 'ad')
    .gte('date', since).lte('date', until)
  const out = {}
  for (const r of data || []) out[r.entity_external_id] = (out[r.entity_external_id] || 0) + Number(r.spend || 0)
  return out
}
