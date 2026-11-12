// POST /api/public/offers/[studio]/[slug]/checkout — start the checkout for one
// studio's sale offer (BLACKFRIDAY.4; OFFERS.4 before it). Public, rate
// limited per IP. Revolut, or un1t.online's hosted checkout for a un1t.online
// studio's memberships and packs: the whole handler, rails and refusals are in
// src/lib/offer-checkout.js (shared with the legacy one-segment route).
import { handleOfferCheckout } from '@/lib/offer-checkout'

export const runtime = 'nodejs'

export async function POST(request, props) {
  const { studio, slug } = await props.params
  return handleOfferCheckout(request, { studio, slug })
}
