// GET /h/[slug]/join — an event host's PUBLIC mailing-list signup page on its
// own (HOST-JOIN-PAGE.1): the same HostListSignup form that sits under the
// events on /h/[slug], with nothing else around it, so the host has one link
// to post on socials that goes straight to "join the list". /h/[slug] keeps
// its own copy of the form (Richard, 21 Oct 2026). Lives under /h/, which
// every public-path allowlist matches by prefix (src/proxy.js publicPaths,
// AppShell PUBLIC_PATHS, the brand allowedPaths in src/lib/brands.js and
// DB_BRAND_DEFAULTS in src/lib/tenant-domains-edge.js), so no allowlist
// change: src/public-compliance-paths.test.jsx pins it.
//
// Server component: host by slug via the service client (notFound when the
// slug is unknown — slugs are public, no enumeration concern). Reads only the
// host's identity and the list copy (mig 460); no events, no counts.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import HostListSignup from '@/components/HostListSignup'
import { poppinsBody as poppins } from '@/fonts/poppins'
import { getOrgBrandName } from '@/lib/location-branding'
import { hostPageMetadata } from '@/lib/host-public-page'
import { todayIsoIn } from '@shared/events'
import { getLocationZone } from '@/lib/location-time'

export const dynamic = 'force-dynamic'

const HOST_COLS = 'id, name, slug, organization_id, list_headline, list_blurb, list_button_label, list_success_message'

export async function generateMetadata(props) {
  try {
    const params = await props.params
    const db = createServerClient()
    const { data: host, error } = await db
      .from('event_hosts')
      .select('id, name, organization_id, anchor_location_id, hero_image_url, list_headline, list_blurb')
      .eq('slug', params.slug)
      .maybeSingle()
    if (error || !host) return {}
    const zone = await getLocationZone(db, host.anchor_location_id || null)
    const { data: events, error: eventsError } = await db
      .from('race_events')
      .select('hero_image_url, host:event_hosts!inner(organization_id)')
      .eq('host_id', host.id)
      .eq('host.organization_id', host.organization_id)
      .eq('active', true)
      .eq('status', 'published')
      .gte('race_date', todayIsoIn(zone))
      .order('race_date')
      .order('start_time')
    if (eventsError) return {}
    const orgName = await getOrgBrandName(db, host.organization_id)
    const requestHeaders = await headers()
    const origin = `${requestHeaders.get('x-forwarded-proto') || 'https'}://${requestHeaders.get('host')}`
    const path = new URL(`/h/${encodeURIComponent(params.slug)}/join`, origin).href
    return hostPageMetadata({ host, events, orgName, path })
  } catch {
    return {}
  }
}

export default async function HostJoinPage(props) {
  const params = await props.params
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select(HOST_COLS)
    .eq('slug', params.slug)
    .maybeSingle()
  if (!host) notFound()

  const orgName = await getOrgBrandName(db, host.organization_id)

  return (
    <div className={`${poppins.variable} font-body flex min-h-screen flex-col items-center justify-center bg-black px-4 py-10 text-white sm:px-8 sm:py-16`}>
      <HostListSignup
        slug={host.slug}
        hostName={host.name}
        orgName={orgName}
        headline={host.list_headline}
        blurb={host.list_blurb}
        buttonLabel={host.list_button_label}
        successMessage={host.list_success_message}
      />
      <p className="mt-10 text-center text-xs text-white/40">
        <Link href={`/h/${encodeURIComponent(host.slug)}`} className="underline underline-offset-2 hover:text-white">
          See {host.name}&rsquo;s upcoming events
        </Link>
      </p>
    </div>
  )
}
