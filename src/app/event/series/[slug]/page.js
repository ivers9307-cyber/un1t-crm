// /event/series/[slug] — HOSTSERIES.1: one public page for a series of event
// dates. Lives under /event/ (already on the four public-path allowlists:
// proxy, AppShell, brands, tenant-domains-edge) and 'series' is a reserved
// event slug, so no event can shadow it. Server component on the service
// client: the series by slug (notFound when unknown; slugs are public), then
// its PUBLISHED upcoming dates as cards linking to /event/<slug>. Waves and
// registrations are embedded only for the sold-out boolean; no count or
// capacity is rendered. Copy is the series' own (headline, blurb) with
// defaults; the hero is the first upcoming date's.

import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { loadSeriesPage, seriesCards, seriesPageCopy } from '@/lib/event-series'
import { pickHostBranding } from '@/lib/host-public-page'
import { getOrgBrandName } from '@/lib/location-branding'
import { todayIsoIn } from '@shared/events'
import SeriesDatesPage from '@/components/SeriesDatesPage'
import { poppinsBody as poppins } from '@/fonts/poppins'

export const dynamic = 'force-dynamic'

async function orgNameFor(db, locationId) {
  try {
    const { data } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
    return data?.organization_id ? await getOrgBrandName(db, data.organization_id) : ''
  } catch {
    return ''
  }
}

export async function generateMetadata(props) {
  try {
    const params = await props.params
    const db = createServerClient()
    const page = await loadSeriesPage(db, { slug: params.slug })
    if (!page) return {}
    const copy = seriesPageCopy(page.series)
    const orgName = await orgNameFor(db, page.series.location_id)
    const title = orgName ? `${copy.headline} — ${orgName}` : copy.headline
    const { heroUrl } = pickHostBranding({}, page.dates)
    const requestHeaders = await headers()
    const origin = `${requestHeaders.get('x-forwarded-proto') || 'https'}://${requestHeaders.get('host')}`
    return {
      title,
      description: copy.blurb,
      openGraph: { title, description: copy.blurb, siteName: orgName || undefined, type: 'website', url: new URL(`/event/series/${encodeURIComponent(params.slug)}`, origin).href, ...(heroUrl ? { images: [{ url: heroUrl }] } : {}) },
      twitter: { card: 'summary_large_image' },
    }
  } catch {
    return {}
  }
}

export default async function SeriesPage(props) {
  const params = await props.params
  const db = createServerClient()
  const page = await loadSeriesPage(db, { slug: params.slug })
  if (!page) notFound()
  const today = todayIsoIn(page.zone)
  const cards = seriesCards(page.dates, { now: Date.now(), zone: page.zone, today })
  const copy = seriesPageCopy(page.series)
  const { heroUrl, accentHex } = pickHostBranding({}, page.dates)
  const orgName = await orgNameFor(db, page.series.location_id)

  return (
    <div className={`${poppins.variable} font-body min-h-screen bg-black px-4 py-10 text-white sm:px-8 sm:py-16`}>
      <div className="mx-auto max-w-5xl">
        <SeriesDatesPage eyebrow={orgName} headline={copy.headline} blurb={copy.blurb} heroUrl={heroUrl} accentHex={accentHex} cards={cards} />
      </div>
    </div>
  )
}
