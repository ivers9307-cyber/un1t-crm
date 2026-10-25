// GET /h/[slug] — an event host's PUBLIC page (HOST-EVENTS-PAGE.1): their
// upcoming events, each linking to /event/[slug] to book and pay, with the
// mailing-list signup (HOST-EMAIL.2) underneath. Lives OUTSIDE the
// auth-gated segments and is allowlisted in src/proxy.js publicPaths,
// AppShell PUBLIC_PATHS, and the un1t-hosts brand allowedPaths
// (src/lib/brands.js) — all three, same as /event/.
//
// Server component: host by slug via the service client (notFound when the
// slug is unknown — slugs are public, no enumeration concern). Events are
// the host's own published, active, upcoming ones. An upcoming event whose
// registration has CLOSED stays listed, badged "Registration closed" and not
// linked to the buy page (HOST-EVENTS-PAGE.2; the studio listing still hides
// them). Waves and
// registrations are embedded ONLY to compute the sold-out boolean; no
// count or capacity is ever rendered. Branding is the host's own
// (mig 707), falling back to the nearest event's hero.

import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import HostListSignup from '@/components/HostListSignup'
import HostPublicEvents from '@/components/host/HostPublicEvents'
import { poppinsBody as poppins } from '@/fonts/poppins'
import { getOrgBrandName } from '@/lib/location-branding'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import { pickHostBranding, hostPageCopy, hostPageEvents, hostPageMetadata } from '@/lib/host-public-page'
import { todayIsoIn } from '@shared/events'
import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

// Same brand-font setup as /event/[slug] — self-hosted Poppins scoped to
// this public subtree via the `--font-body` variable.

export const dynamic = 'force-dynamic'

const HOST_COLS = 'id, name, slug, organization_id, anchor_location_id, list_headline, list_blurb, list_button_label, list_success_message, hero_image_url, accent_hex, events_headline, events_blurb'

// Public-safe SELECT. Embeds exist only for the sold-out boolean.
const EVENT_COLS = 'slug, name, kind, race_date, start_time, venue_name, hero_image_url, accent_hex, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity, start_time ), registrations:race_registrations ( status, wave_id, looking_for_team, team:teams ( size ) )'

// TZ.9 — a host's events live on its anchor location, so the page runs on
// that studio's clock. This page is display-only: an unreadable zone falls
// back to DEFAULT_TZ, said in a warning, rather than failing the page.
async function hostZone(db, host) {
  try {
    return await getLocationZone(db, host.anchor_location_id || null)
  } catch (err) {
    logWarn('host-public-page', 'anchor zone unreadable; page shown on the default zone', { err, hostId: host.id })
    return DEFAULT_TZ
  }
}

async function loadHostEvents(db, hostId, zone) {
  const today = todayIsoIn(zone)
  const nowMs = Date.now()
  const { data: rows } = await db
    .from('race_events')
    .select(EVENT_COLS)
    .eq('host_id', hostId)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', today)
  // Closed-registration events stay listed (HOST-EVENTS-PAGE.2); past ones go.
  const upcoming = hostPageEvents(rows, today)
  return { upcoming, nowMs }
}

export async function generateMetadata(props) {
  try {
    const params = await props.params
    const db = createServerClient()
    const { data: host, error } = await db
      .from('event_hosts')
      .select('id, name, organization_id, anchor_location_id, hero_image_url, events_headline, events_blurb, list_blurb')
      .eq('slug', params.slug)
      .maybeSingle()
    if (error || !host) return {}
    const zone = await hostZone(db, host)
    let events = []
    try {
      const { data, error: eventsError } = await db
        .from('race_events')
        // Make host tenancy explicit for check:location-scoping, including staff-assigned events at other studios.
        .select('hero_image_url, host:event_hosts!inner(organization_id)')
        .eq('host_id', host.id)
        .eq('host.organization_id', host.organization_id)
        .eq('active', true)
        .eq('status', 'published')
        .gte('race_date', todayIsoIn(zone))
        .order('race_date')
        .order('start_time')
      if (!eventsError) events = data || []
    } catch (err) {
      logWarn('host-public-metadata', 'event heroes unreadable; using host branding', { err, hostId: host.id })
    }
    const orgName = await getOrgBrandName(db, host.organization_id)
    const requestHeaders = await headers()
    const origin = `${requestHeaders.get('x-forwarded-proto') || 'https'}://${requestHeaders.get('host')}`
    const path = new URL(`/h/${encodeURIComponent(params.slug)}`, origin).href
    return hostPageMetadata({ host, events, orgName, path, page: 'events' })
  } catch {
    return {}
  }
}

export default async function HostPublicPage(props) {
  const params = await props.params
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select(HOST_COLS)
    .eq('slug', params.slug)
    .maybeSingle()
  if (!host) notFound()

  const zone = await hostZone(db, host)
  const [orgName, { upcoming, nowMs }] = await Promise.all([
    getOrgBrandName(db, host.organization_id),
    loadHostEvents(db, host.id, zone),
  ])
  const cards = upcoming.map((e) =>
    toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now: nowMs, zone }),
  )
  const { heroUrl, accentHex } = pickHostBranding(host, upcoming)
  const copy = hostPageCopy(host)

  return (
    <div className={`${poppins.variable} font-body min-h-screen bg-black px-4 py-10 text-white sm:px-8 sm:py-16`}>
      <div className="mx-auto max-w-5xl">
        <HostPublicEvents
          hostName={host.name}
          headline={copy.headline}
          blurb={copy.blurb}
          heroUrl={heroUrl}
          accentHex={accentHex}
          cards={cards}
        />
        <div className="mt-16 flex justify-center">
          <HostListSignup
            slug={host.slug}
            hostName={host.name}
            orgName={orgName}
            headline={host.list_headline}
            blurb={host.list_blurb}
            buttonLabel={host.list_button_label}
            successMessage={host.list_success_message}
          />
        </div>
      </div>
    </div>
  )
}
