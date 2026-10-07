// GET /h/[slug] — an event host's PUBLIC page (HOST-EVENTS-PAGE.1): their
// upcoming events, each linking to /event/[slug] to book and pay, with the
// mailing-list signup (HOST-EMAIL.2) underneath. Lives OUTSIDE the
// auth-gated segments and is allowlisted in src/proxy.js publicPaths,
// AppShell PUBLIC_PATHS, and the un1t-hosts brand allowedPaths
// (src/lib/brands.js) — all three, same as /event/.
//
// Server component: host by slug via the service client (notFound when the
// slug is unknown — slugs are public, no enumeration concern). Events are
// the host's own published, active, upcoming ones whose registration
// window is open — the same filters as the studio listing. Waves and
// registrations are embedded ONLY to compute the sold-out boolean; no
// count or capacity is ever rendered. Branding is the host's own
// (mig 707), falling back to the nearest event's hero.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import HostListSignup from '@/components/HostListSignup'
import HostPublicEvents from '@/components/host/HostPublicEvents'
import { poppinsBody as poppins } from '@/fonts/poppins'
import { getOrgBrandName } from '@/lib/location-branding'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import { pickHostBranding, hostPageCopy } from '@/lib/host-public-page'
import { orderEventsForBrowse, todayIsoDublin } from '@shared/events'

// Same brand-font setup as /event/[slug] — self-hosted Poppins scoped to
// this public subtree via the `--font-body` variable.

export const dynamic = 'force-dynamic'

const HOST_COLS = 'id, name, slug, organization_id, list_headline, list_blurb, list_button_label, list_success_message, hero_image_url, accent_hex, events_headline, events_blurb'

// Public-safe SELECT. Embeds exist only for the sold-out boolean.
const EVENT_COLS = 'slug, name, kind, race_date, start_time, venue_name, hero_image_url, accent_hex, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity, start_time ), registrations:race_registrations ( status, wave_id, team:teams ( size ) )'

async function loadHostEvents(db, hostId) {
  const today = todayIsoDublin()
  const nowMs = Date.now()
  const { data: rows } = await db
    .from('race_events')
    .select(EVENT_COLS)
    .eq('host_id', hostId)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', today)
  const open = (rows || []).filter((e) => {
    const closesAt = e.registration_closes_at ? Date.parse(e.registration_closes_at) : null
    return !(closesAt && nowMs > closesAt)
  })
  const { upcoming } = orderEventsForBrowse(open, today)
  return { upcoming, nowMs }
}

export async function generateMetadata(props) {
  const params = await props.params
  try {
    const db = createServerClient()
    const { data } = await db
      .from('event_hosts')
      .select('name, events_blurb, list_blurb')
      .eq('slug', params.slug)
      .maybeSingle()
    if (!data) return {}
    return {
      title: `${data.name} — upcoming events`,
      description: data.events_blurb || data.list_blurb || `Book ${data.name}'s upcoming events.`,
    }
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

  const [orgName, { upcoming, nowMs }] = await Promise.all([
    getOrgBrandName(db, host.organization_id),
    loadHostEvents(db, host.id),
  ])
  const cards = upcoming.map((e) =>
    toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now: nowMs }),
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
