// /welcome/[location]/events — public events listing for a studio.
// Surfaced as /[location]/events via next.config rewrites. Inherits the
// /welcome layout (Poppins + #lp-shell). Lists active, upcoming race_events
// for the studio; cards link to the existing /event/[slug] booking.
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { resolveLocationBrand, resolveOrgChrome } from '@/lib/host-brand'
import { resolveGymSiteName } from '@/lib/default-site-name'
import { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'
import { orderEventsForBrowse, todayIsoDublin } from '@shared/events'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import PublicEventsList from '@/components/landing-page/PublicEventsList'
import InstagramStrip from '@/components/landing-page/InstagramStrip'
import { sharedEventsOrFilterFor } from '@/lib/event-visibility'

export const dynamic = 'force-dynamic'

// Resolve a studio's landing row by its public_path. Mirrors welcome/[location]/page.js.
async function loadByPath(path) {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('*, locations:location_id ( id, name, organization_id )')
      .eq('public_path', path)
      .maybeSingle()
    if (error) return null
    return data || null
  } catch {
    return null
  }
}

// Latest cached IG posts for the strip, with public thumbnail URLs resolved.
async function loadInstagramPosts(db, locationId) {
  const { data } = await db
    .from('instagram_feed_posts')
    .select('id, ig_username, is_reel, permalink, caption, thumb_path, posted_at')
    .eq('location_id', locationId)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(10)
  if (!data || data.length === 0) return { posts: [], username: null }
  const posts = data.map((p) => ({
    id: p.id,
    permalink: p.permalink,
    is_reel: p.is_reel,
    caption: p.caption,
    thumb_url: db.storage.from('instagram-feed').getPublicUrl(p.thumb_path).data.publicUrl,
  }))
  return { posts, username: data[0].ig_username || null }
}

// W1.L4 — the OG site name is THIS studio's brand and the not-found title
// is the host's organisation brand; neither is a literal (mirrors
// welcome/[location]/page.js).
export async function generateMetadata(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  const hostBrand = await resolveGymSiteName({ host: (await headers()).get('host') })
  if (!row || !isPubliclyVisible(row.publish_state)) return { title: hostBrand }
  const brand = (await resolveLocationBrand({ locationId: row.location_id })).companyName || hostBrand
  const studioName = row.locations?.name || brand
  const title = `Events — ${studioName}`
  const description = `Upcoming races, workshops and open days at ${studioName}. Book your spot.`
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: brand,
      type: 'website',
    },
  }
}

export default async function StudioEventsPage(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  if (!row || !isPubliclyVisible(row.publish_state)) notFound()

  // W0.3 — a page row with no location is a 404 before any query, never a
  // `location_id.eq.undefined` reaching PostgREST.
  const locationId = row.locations?.id
  if (!locationId) notFound()
  // W1.S1b — the studio's brand and its org's site chrome, cached
  // (host-brand.js); the fallbacks name THIS studio, never a literal.
  const [brand, chrome] = await Promise.all([
    resolveLocationBrand({ locationId }),
    resolveOrgChrome({ orgId: row.locations?.organization_id || null }),
  ])
  const studioName = row.locations?.name || brand.companyName
  const today = todayIsoDublin()
  const nowMs = Date.now()

  const logoUrl     = row.logo_url || null
  const logoAlt     = row.logo_alt || brand.companyName
  const logoWidthPx = row.logo_width_px || 200

  const db = createServerClient()
  // Public-safe SELECT, scoped to this studio's active upcoming events.
  // Includes shared events (visible across the owning organisation, W0.3).
  // Embeds waves +
  // registrations ONLY to compute a coy sold-out boolean — raw
  // capacity/counts are never rendered.
  const orFilter = await sharedEventsOrFilterFor(db, locationId)
  const { data: rows } = await db
    .from('race_events')
    .select('slug, name, kind, race_date, start_time, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity ), registrations:race_registrations ( status, wave_id, team:teams ( size ) )')
    .or(orFilter)
    .eq('active', true)
    .eq('status', 'published')
    .is('host_id', null)
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

  // Instagram strip (EVENTS-IG.1) — cached posts for this studio, gated on the
  // operator toggle. Absent/true → shown; only false hides it.
  const ig = row.show_instagram_feed !== false
    ? await loadInstagramPosts(db, locationId)
    : { posts: [], username: null }

  const eventsHref = `/${row.public_path}/events`

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={logoUrl}
        logoAlt={logoAlt}
        logoWidthPx={logoWidthPx}
        wordmark={brand.shortName}
        sticky
        eventsHref={eventsHref}
      />
      <PublicEventsList studioName={studioName} cards={cards} />
      {ig.posts.length > 0 && (
        <div className="bg-black px-5 sm:px-8">
          <div className="max-w-5xl mx-auto">
            <InstagramStrip
              posts={ig.posts}
              username={ig.username}
              profileUrl={ig.username ? `https://instagram.com/${ig.username}` : null}
            />
          </div>
        </div>
      )}
      <SiteFooter ctaHref={`/${row.public_path}#book`} brand={chrome.companyName} studios={chrome.studios} legalName={chrome.legalName} />
    </div>
  )
}
