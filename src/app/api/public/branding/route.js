import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getLocationBranding } from '@/lib/location-branding'
import { productName, pointsUnit } from '@/lib/brand-name'
import { resolveHostBrand } from '@/lib/host-brand'
import { PLATFORM_SITE_NAME } from '@/lib/default-site-name'
import { PLATFORM_FAVICON_URL } from '@/lib/default-favicon'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

// GET /api/public/branding — Public endpoint for logo/favicon (no auth needed)
// Returns branding for a specific location_id, or — anonymous (login screen,
// reset-password: no location known yet) — for the REQUEST HOST's
// organisation (W1.L4).
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const db = createServerClient()

  // Public-browse abuse limiter (audit H2a) — 60-per-5-min per tenant+IP: the
  // login screen / public pages fetch this once per load, so a human never
  // gets near the cap; it only bites scripted floods. Tenant-keyed per SAAS-6
  // ('default' for the anonymous no-location variant). Fails open inside
  // checkRateLimit so a limiter outage never blanks a logo.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `pubbranding:${locationId || 'default'}:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  if (locationId) {
    const b = await getLocationBranding(db, locationId)
    // W1.B2 — the phone's brand source. `short_name` is the wordmark the
    // product names are built from (org_settings.short_name, mig 715; falls
    // back to the brand), and `product_names` ships them ready-made so a
    // screen that only needs "{Brand} Points" never imports the helper. An
    // unresolved brand answers empty strings and bare nouns — never a literal.
    return NextResponse.json({
      success: true,
      data: {
        logo_url: b.logoUrl,
        favicon_url: b.faviconUrl,
        company_name: b.companyName,
        short_name: b.shortName,
        product_names: { points: productName(b.shortName, 'points'), hr: productName(b.shortName, 'hr') },
        points_unit: pointsUnit(b.shortName),
      },
    })
  }

  // Anonymous visitor — the host's organisation (W1.L4). Before this it read
  // ONE company_settings row estate-wide (no order), so every tenant's login
  // screen wore whichever logo sorted first. A CRM host, an unmapped host or
  // a resolver failure answers the PLATFORM's name and mark: no gym is in
  // the picture there, and never another tenant's logo. resolveHostBrand is
  // the ONE per-host cache the site name and favicon read too, so a login
  // screen costs no reads of its own inside the window.
  const b = await resolveHostBrand({ host: request.headers.get('host'), db })
  if (b.orgId) {
    return NextResponse.json({
      success: true,
      data: { logo_url: b.logoUrl, favicon_url: b.faviconUrl, company_name: b.companyName || null },
    })
  }

  return NextResponse.json({
    success: true,
    data: { logo_url: null, favicon_url: PLATFORM_FAVICON_URL, company_name: PLATFORM_SITE_NAME },
  })
}
