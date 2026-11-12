// /offers/[studio] layout (BLACKFRIDAY.3) — the tab title and the footer for
// one studio's storefront and product pages, read from THAT studio's
// sale_offers rows only (sale_offers is unique on (location_id, slug)).
//
// An unknown key is not this layout's business: the page below either
// redirects a legacy /offers/<slug> link or 404s, so this renders the
// children bare with the generic title.
import { createServerClient } from '@/lib/supabase'
import { formatSaleDeadline } from '@/lib/sale-offers'
import { resolveOfferStudio, offersPageCopy } from '@/lib/offer-studios'
import { storefrontTitle } from '@/lib/offers-storefront'
import { displayZoneFor } from '@/lib/display-zone'
import { logWarn } from '@/lib/log'

const GENERIC_METADATA = { title: 'Black Friday — UN1T', robots: { index: false, follow: false } }

export async function generateMetadata(props) {
  const { studio: key } = await props.params
  const db = createServerClient()
  const resolved = await resolveOfferStudio(db, key)
  if (!resolved) return GENERIC_METADATA
  const { studio, location } = resolved
  const { data, error } = await db
    .from('sale_offers')
    .select('category')
    .eq('active', true)
    .eq('location_id', location.id)
  if (error) logWarn('offers', 'sale_offers unreadable for the tab title', { locationId: location.id, code: error.code ?? null })
  // OFFERS.8 — one rule with the page's hero (src/lib/offers-storefront.js).
  const cats = new Set((data || []).map((o) => o.category))
  return {
    title: storefrontTitle(cats, studio.label),
    robots: { index: false, follow: false },
  }
}

export default async function OfferStudioLayout(props) {
  const { children } = props
  const { studio: key } = await props.params
  const db = createServerClient()
  const resolved = await resolveOfferStudio(db, key)
  if (!resolved) return children
  const { studio, location } = resolved

  // Deadline is DERIVED from the live sale window, never hard-coded — see
  // formatSaleDeadline(). Only DATED offers can produce a deadline line.
  // Gift cards carry ends_at NULL, and Postgres sorts NULLs first on DESC —
  // without the not-null filter a live gift card would win the ordering and
  // blank out a real sale's deadline in the footer.
  const { data, error } = await db
    .from('sale_offers')
    .select('ends_at')
    .eq('active', true)
    .eq('location_id', location.id)
    .not('ends_at', 'is', null)
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) logWarn('offers', 'sale_offers unreadable for the footer deadline', { locationId: location.id, code: error.code ?? null })
  // TZ.16 — the deadline on the studio's own clock (display only).
  const zone = await displayZoneFor(db, null, location.id, 'offers')
  const deadline = formatSaleDeadline(data?.ends_at, { zone })
  const { legalLine } = offersPageCopy(location)

  return (
    <>
      {children}
      <footer style={{ padding: '40px 32px', color: '#666', fontSize: 12, letterSpacing: '.12em', borderTop: '1px solid var(--ofr-line)' }}>
        {studio.label.toUpperCase()}{deadline ? ` · SALE ENDS ${deadline}` : ''}{legalLine ? ` · ${legalLine}` : ''}
      </footer>
    </>
  )
}
