// /welcome/[location] — public per-studio marketing page.
//
// The two-location split (un1tdublin.com): the chooser lives at
// /welcome and links to /welcome/stillorgan + /welcome/hatch-street
// (surfaced publicly as /stillorgan + /hatch-street via next.config
// rewrites). Each studio's content is its own landing_page_settings
// row, resolved here by `public_path` (mig 227) so the public URL is
// decoupled from internal location slugs.
//
// Renders the same SiteHeader → ordered blocks → SiteFooter via the
// shared BlockRenderers. Editing happens in /settings/landing-page
// (per active location); the live-preview iframe still uses ?edit=1.
//
// WEBSITE-REDESIGN 2026-06 additions (public render only):
//   · Sticky glass header with a CTA computed from the page's OWN
//     funnel blocks (lead_form → #waitlist, booking → #book, event →
//     its anchor) — the conversion action is always one tap away.
//   · Scroll-reveal arming script + RevealManager island (see
//     reveal-arm.js for the degradation table). Edit mode never
//     mounts either, so the editor previews static blocks.
//   · JSON-LD (Gym) via the JsonLd island for richer search results.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault, primaryCta } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'
import RevealManager from '@/components/landing-page/RevealManager'
import JsonLd from '@/components/landing-page/JsonLd'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'

export const dynamic = 'force-dynamic'

// Resolve a studio's landing row by its public_path. Joins the
// location for the display name (used in metadata). Returns null on
// miss so the page can 404 cleanly.
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
  const blocks = blocksOrDefault(row.blocks)
  const hero = blocks.find((b) => b.type === 'hero')
  const heroImage = hero?.image_url || null
  const studioName = row.locations?.name || 'UN1T Dublin'
  const description = hero?.subtext
    || 'Coach-led strength + conditioning, built for racing. Book your free consultation.'
  const title = `${studioName} — Strength + conditioning, built for racing`
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: 'UN1T Dublin',
      type: 'website',
      ...(heroImage ? { images: [{ url: heroImage }] } : {}),
    },
  }
}

export default async function StudioLandingPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const row = await loadByPath(params.location)
  if (!row) notFound()

  // Public reachability gate. A page that isn't 'live' 404s for the public,
  // but the editor's live-preview iframe (?edit=1) still renders so the
  // operator can preview before publishing.
  const isEditPreview = searchParams?.edit === '1'
  if (!isEditPreview && !isPubliclyVisible(row.publish_state)) notFound()

  const blocks = blocksOrDefault(row.blocks)

  // Reviews carousel data — only query when the page has a reviews block.
  // One read for the page; the renderer filters/sizes in JS.
  let reviewsData = null
  const reviewsBlock = blocks.find((b) => b.type === 'reviews')
  if (reviewsBlock && row.location_id) {
    const db = createServerClient()
    const minRating = Number.isFinite(reviewsBlock.min_rating) ? reviewsBlock.min_rating : 4
    const [{ data: reviews }, { data: conn }] = await Promise.all([
      db.from('google_reviews')
        .select('id, google_review_id, rating, comment, author_name, author_photo_url, review_time, hidden')
        .eq('location_id', row.location_id)
        .eq('hidden', false)
        .gte('rating', minRating)
        .not('comment', 'is', null)
        .order('review_time', { ascending: false })
        .limit(30),
      db.from('google_business_connections')
        .select('average_rating, total_review_count')
        .eq('location_id', row.location_id)
        .maybeSingle(),
    ])
    reviewsData = {
      reviews: reviews || [],
      averageRating: conn?.average_rating ?? null,
      totalCount: conn?.total_review_count ?? null,
    }
  }

  const logoUrl     = row.logo_url || null
  const logoAlt     = row.logo_alt || 'UN1T Dublin'
  const logoWidthPx = row.logo_width_px || 200

  // Edit-mode preview (LP multi-page). The /settings/landing-page editor
  // loads THIS studio's page with ?edit=1 in its preview iframe; mount
  // the postMessage-driven overlay seeded from this studio's content so
  // the preview reflects the studio being edited.
  if (searchParams?.edit === '1') {
    return (
      <EditModeOverlay
        initialBlocks={blocks}
        initialLogoUrl={logoUrl}
        initialLogoAlt={logoAlt}
        initialLogoWidthPx={logoWidthPx}
      />
    )
  }

  const cta = primaryCta(blocks)
  const studioName = row.locations?.name || 'UN1T Dublin'
  const hero = blocks.find((b) => b.type === 'hero')

  // Gym structured data — name, url, hero image; aggregate rating only
  // when a synced Google Business connection has one (never invented).
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Gym',
    name: studioName,
    url: `https://un1tdublin.com/${params.location}`,
    ...(hero?.image_url ? { image: hero.image_url } : {}),
    ...(logoUrl ? { logo: logoUrl } : {}),
    ...(reviewsData?.averageRating != null && reviewsData?.totalCount
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Number(reviewsData.averageRating).toFixed(1),
            reviewCount: reviewsData.totalCount,
          },
        }
      : {}),
  }

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <JsonLd data={jsonLd} />
      <SiteHeader
        logoUrl={logoUrl}
        logoAlt={logoAlt}
        logoWidthPx={logoWidthPx}
        sticky
        ctaHref={cta?.href || null}
        ctaLabel={cta?.label}
      />
      {blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={params.location}
          reviewsData={reviewsData}
          ctaHref={cta?.href || null}
          ctaLabel={cta?.label}
        />
      ))}
      <SiteFooter ctaHref={cta?.href || '#book'} ctaLabel={cta?.label || 'Book a free consult'} />
    </div>
  )
}
