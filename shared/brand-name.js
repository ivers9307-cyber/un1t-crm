// W1.B1 — product names are built from the tenant's brand, never spelled.
// Pure; consumed by web (src/lib/brand-name.js re-export), mobile and
// champ-app. The brand string comes from getLocationBranding (web) or
// /api/public/branding?location_id= (phone / champ-app). Pass the SHORT
// brand (org_settings.short_name, mig 715; `shortName` on the resolver) so
// "UN1T" stays "UN1T Points" while the org's brand reads "UN1T Dublin".
export const PLATFORM_NAME = 'Repset'

const NOUNS = Object.freeze({ points: 'Points', hr: 'HR' })

/** `${brand} Points` / `${brand} HR`; bare noun when the brand is unknown. */
export function productName(brand, kind) {
  const noun = NOUNS[kind]
  if (!noun) throw new Error(`productName: unknown kind ${kind}`)
  const b = (brand || '').trim()
  return b ? `${b} ${noun}` : noun
}

/** The short unit after a number ("280 UN1T"); "pts" when unknown. */
export function pointsUnit(brand) {
  const b = (brand || '').trim()
  return b || 'pts'
}
