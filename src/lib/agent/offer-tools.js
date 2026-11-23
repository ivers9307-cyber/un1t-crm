// MIAPAGES.1 — Mia's read of what is on offer right now: every live landing
// page and every sellable storefront offer in the conversation's organisation
// (offer-read.js), always fresh from the database, like list_upcoming_events.
//
// AUTH MODEL: public information, no identity needed. It reads nothing about
// the customer and writes nothing. Payment never happens in chat: each entry
// carries its page's link.
//
// Scoping: the organisation is read from the thread's own studio
// (ctx.locationId), never from anything the customer or the model supplies.
//
// The executor never throws. A failed read is "unreadable", never "no offers".
import { logWarn } from '@/lib/log'
import { readCurrentOffers } from './offer-read'

// Model-facing text: no em or en dashes.
export const OFFER_TOOLS = [
  {
    name: 'list_current_offers',
    description:
      'List what the studio is offering right now, read live: every public page that is switched on ' +
      "(trials, free class offers, sales) and every offer in the online store, for this studio and the organisation's " +
      'other studios. Each entry says who it is for, its price_label, its ends_label when it has an end date, and its url. ' +
      'Pages come in priority order and one is marked lead. No identity verification needed. Call this before you answer ' +
      'anything about trying the studio, joining, prices, class packs, gift cards, deals or a sale, and before you state ' +
      "any offer's price, end date or link. Copy price_label and ends_label exactly. Entries flagged while_stocks_last may be " +
      'described as available while stocks last; never give a number. Never share the url of an entry flagged sold_out.',
    input_schema: { type: 'object', properties: {} },
  },
]

export const OFFER_TOOL_NAMES = new Set(OFFER_TOOLS.map((t) => t.name))

const UNREADABLE = Object.freeze({
  error: 'offers_unreadable',
  message:
    'The offers could not be read just now. Say you cannot check at the moment and offer to pass them to the team. ' +
    'Never say there are no offers.',
})

const NOTHING_MESSAGE = 'Nothing is on offer online right now. Do not invent an offer; hand off if they want to buy.'

/** ctx: { db, locationId }. Never throws. */
export async function executeOfferTool(toolName, _input, ctx) {
  if (!OFFER_TOOL_NAMES.has(toolName)) return { error: 'unknown_tool', message: 'That tool does not exist.' }
  const db = ctx?.db
  const locationId = ctx?.locationId
  if (!db || !locationId) return { ...UNREADABLE }
  try {
    const { data: loc, error } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
    if (error || !loc?.organization_id) {
      logWarn('mia-offers', 'thread studio unreadable for its offers', { locationId, code: error?.code ?? null })
      return { ...UNREADABLE }
    }
    const { resolveCustomerBaseUrl } = await import('@/lib/tenant-host')
    const baseUrl = await resolveCustomerBaseUrl(db, locationId)
    const res = await readCurrentOffers(db, { organizationId: loc.organization_id, threadLocationId: locationId, baseUrl })
    if (!res?.ok) return { ...UNREADABLE }
    if (res.studios.length === 0) return { studios: [], message: NOTHING_MESSAGE }
    return { studios: res.studios }
  } catch (err) {
    logWarn('mia-offers', 'list_current_offers threw', { locationId, errClass: err?.name })
    return { ...UNREADABLE }
  }
}
