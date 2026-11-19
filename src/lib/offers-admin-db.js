// OFFERSEDIT.1 — the two reads the offers editor routes share. Named columns,
// scoped to the studio; a failed read answers { error }, never an empty list,
// so a database blip can never make a sellable offer look unsellable or the
// other way round.
import { logError } from '@/lib/log'

/** @returns {Promise<{ location?: { id: string, membership_source: string|null }, error?: object }>} */
export async function readStudioForOffers(db, locationId) {
  const { data, error } = await db.from('locations').select('id, membership_source').eq('id', locationId).maybeSingle()
  if (error || !data) {
    logError('offers-admin', 'studio unreadable', { locationId, code: error?.code ?? null })
    return { error: error || new Error('studio not found') }
  }
  return { location: data }
}

/**
 * The studio's mirrored un1t.online products, for the picker and the price
 * check. Empty (not an error) at a studio that does not sell through un1t.online.
 * @returns {Promise<{ list: Array<{ un1t_id: string, title: string|null, type: string|null, price_cents: number|null, status: string|null }>, error?: object }>}
 */
export async function readUn1tProducts(db, location) {
  if (location?.membership_source !== 'un1t_online') return { list: [] }
  const { data, error } = await db.from('un1t_products')
    .select('un1t_id, title, type, price_cents, status')
    .eq('location_id', location.id)
    .order('title', { ascending: true })
    .limit(500)
  if (error) {
    logError('offers-admin', 'un1t.online products unreadable', { locationId: location.id, code: error.code ?? null })
    return { list: [], error }
  }
  return { list: data || [] }
}

export function productFor(list, productId) {
  if (!productId) return null
  return (list || []).find((p) => p.un1t_id === productId) || null
}
