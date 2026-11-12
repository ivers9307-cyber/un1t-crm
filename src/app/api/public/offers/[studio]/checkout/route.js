// POST /api/public/offers/[slug]/checkout — the pre-BLACKFRIDAY URL, kept for
// offer pages loaded before the per-studio deploy (every one of them was a
// Stillorgan offer). Next.js forbids two different dynamic names at one level,
// so the segment is named [studio] beside [studio]/[slug]/checkout; its value
// here is the legacy Stillorgan offer SLUG. Same handler, studio 'stillorgan'.
import { handleOfferCheckout } from '@/lib/offer-checkout'

export const runtime = 'nodejs'

export async function POST(request, props) {
  const { studio: legacySlug } = await props.params
  return handleOfferCheckout(request, { studio: 'stillorgan', slug: legacySlug })
}
