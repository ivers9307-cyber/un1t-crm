// W0.4 — /offers, /offers/[slug] and the offer checkout are ONE public
// surface that used to list every active sale_offers row across all
// tenants under a "UN1T STILLORGAN" header, and always charged the
// platform Revolut merchant. Until Wave 2 gives each tenant its own offers
// route and payment rail, the surface is pinned to Stillorgan: other
// locations' offers are not listed and their slugs answer 404.
export const OFFERS_HOME_LOCATION_SLUG = 'un1t-stillorgan'

// Filter value when the pinned location row is missing: matches no row, so a
// list renders empty rather than falling open to every location.
export const NO_HOME_LOCATION_ID = '00000000-0000-0000-0000-000000000000'

/** Pure. */
export function offerBelongsToHome(offer, homeLocationId) {
  return Boolean(homeLocationId && offer?.location_id === homeLocationId)
}

/** The pinned location's id, or null when the row is missing (page then renders empty / 404). */
export async function resolveOffersHomeLocationId(db) {
  const { data } = await db.from('locations').select('id').eq('slug', OFFERS_HOME_LOCATION_SLUG).maybeSingle()
  return data?.id || null
}
