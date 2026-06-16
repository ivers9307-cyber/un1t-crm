// /welcome/[location]/events — public events listing for a studio.
// Surfaced as /[location]/events via next.config rewrites. Inherits the
// /welcome layout (Poppins + #lp-shell). Lists active, upcoming race_events
// for the studio; cards link to the existing /event/[slug] booking.
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'
import { orderEventsForBrowse, todayIsoDublin } from '@shared/events'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import PublicEventsList from '@/components/landing-page/PublicEventsList'

export const dynamic = 'force-dynamic'

// Resolve a studio's landing row by its public_path. Mirrors welcome/[location]/page.js.
async function loadByPath(path) {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('*, locations:location_id ( id, name )')
      .eq('public_path', path)
      .maybeSingle()
    if (error) return null
    return data || null
  } catch {
    return null
  }
}

export async function generateMetadata(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  if (!row || !isPubliclyVisible(row.publish_state)) return { title: 'UN1T Dublin' }
  const studioName = row.locations?.name || 'UN1T Dublin'
  const title = `Events — ${studioName}`
  const description = `Upcoming races, workshops and open days at ${studioName}. Book your spot.`
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: 'UN1T Dublin',
      type: 'website',
    },
  }
}

export default async function StudioEventsPage(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  if (!row || !isPubliclyVisible(row.publish_state)) notFound()

  const locationId = row.locations?.id
  const studioName = row.locations?.name || 'UN1T Dublin'
  const today = todayIsoDublin()
  const nowMs = Date.now()

  const logoUrl     = row.logo_url || null
  const logoAlt     = row.logo_alt || 'UN1T Dublin'
  const logoWidthPx = row.logo_width_px || 200

  const db = createServerClient()
  // Public-safe SELECT, scoped to this studio's active upcoming events.
  // Includes shared events (visible across locations). Embeds waves +
  // registrations ONLY to compute a coy sold-out boolean — raw
  // capacity/counts are never rendered.
  const { data: rows } = await db
    .from('race_events')
    .select('slug, name, kind, race_date, start_time, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity ), registrations:race_registrations ( status, wave_id, team:teams ( size ) )')
    .or(`location_id.eq.${locationId},shared.eq.true`)
    .eq('active', true)
    .gte('race_date', today)

  // Drop events whose registration window has closed; order nearest-first.
  const open = (rows || []).filter((e) => {
    const closesAt = e.registration_closes_at ? Date.parse(e.registration_closes_at) : null
    return !(closesAt && nowMs > closesAt)
  })
  const { upcoming } = orderEventsForBrowse(open, today)
  const cards = upcoming.map((e) =>
    toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now: nowMs })
  )

  const eventsHref = `/${row.public_path}/events`

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={logoUrl}
        logoAlt={logoAlt}
        logoWidthPx={logoWidthPx}
        sticky
        eventsHref={eventsHref}
      />
      <PublicEventsList studioName={studioName} cards={cards} />
      <SiteFooter ctaHref={`/${row.public_path}#book`} />
    </div>
  )
}
