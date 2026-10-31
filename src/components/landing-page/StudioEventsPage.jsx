// PAGES.1 — a studio page's public events listing (/stillorgan/events),
// moved here from src/app/welcome/[location]/events/page.js and rendered by
// the one [slug] route. Lists the studio's active, upcoming race_events
// (shared events of its organisation included, W0.3); cards link to the
// existing /event/[slug] booking.
//
// Server component. The route resolves the page row, the studio's location
// (id, name, timezone) and the chrome (brand, logo, footer) and hands them in;
// only public-safe columns are selected here, and the waves + registrations
// embed feeds a coy sold-out boolean only: raw capacity/counts are never
// rendered.

import { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import { orderEventsForBrowse, todayIsoIn } from '@shared/events'
import { zoneOfLocation } from '@/lib/location-time'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import PublicEventsList from '@/components/landing-page/PublicEventsList'
import InstagramStrip from '@/components/landing-page/InstagramStrip'
import { sharedEventsOrFilterFor } from '@/lib/event-visibility'

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

/**
 * @param {{
 *   db: object,                 service-role client (server only)
 *   slug: string,               the studio page's slug (its public path)
 *   location: { id, name, timezone },
 *   brand: { companyName, shortName },
 *   logo: { url, alt, widthPx },
 *   footer: { brand, studios, legalName },
 *   showInstagramFeed: boolean,
 * }} props
 */
export default async function StudioEventsPage({ db, slug, location, brand = {}, logo = {}, footer = {}, showInstagramFeed = true }) {
  const locationId = location.id
  const studioName = location.name || brand.companyName
  // TZ.9 — the studio's own day and clock.
  const zone = zoneOfLocation(location)
  const today = todayIsoIn(zone)
  const nowMs = Date.now()

  // Public-safe SELECT, scoped to this studio's active upcoming events,
  // shared events of its organisation included (W0.3).
  const orFilter = await sharedEventsOrFilterFor(db, locationId)
  const { data: rows } = await db
    .from('race_events')
    .select('slug, name, kind, race_date, start_time, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity ), registrations:race_registrations ( status, wave_id, looking_for_team, team:teams ( size ) )')
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
    toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now: nowMs, zone })
  )

  // Instagram strip (EVENTS-IG.1): the page's show_instagram_feed switch
  // (chrome); absent/true shows it, only false hides it.
  const ig = showInstagramFeed
    ? await loadInstagramPosts(db, locationId)
    : { posts: [], username: null }

  const eventsHref = `/${slug}/events`

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <SiteHeader
        logoUrl={logo.url || null}
        logoAlt={logo.alt || ''}
        logoWidthPx={logo.widthPx || 200}
        wordmark={brand.shortName || ''}
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
      <SiteFooter ctaHref={`/${slug}#book`} brand={footer.brand} studios={footer.studios} legalName={footer.legalName} />
    </div>
  )
}
