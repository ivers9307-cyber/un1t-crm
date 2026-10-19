// MIAHATCH.4 (Task 14) — limits on the "What Mia can sell" list. Their own
// file so the settings editor (a client component) and the route's schema
// share one number without the editor pulling in lib/schemas.js.
// 140 mirrors mia_purchase_offers_blurb_check (mig 752).
export const MIA_OFFER_BLURB_MAX = 140
export const MIA_OFFERS_MAX = 50

// The one rule for "Mia may sell this product": active at the studio and priced
// above zero (whole cents). Shared by the offer list route and anything that
// lists purchase options for a customer, so the two can never disagree.
// `UN1T_PRODUCT_ACTIVE_STATUS` is un1t-tools.js's 'active'; kept as a literal
// here so this file stays client-safe and import-free.
export function isSellableUn1tProduct(product) {
  return !!product
    && product.status === 'active'
    && Number.isInteger(product.price_cents)
    && product.price_cents > 0
}
