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
//
// TRIALFIRST.1 — a studio whose paid trial is for sale shows the buy card in
// its hero (#trial), and the trial owns the header, hero and footer CTA. A
// buyer sent off to pay (Revolut 3DS, un1t.online's checkout) comes back here
// with `?purchase=<id>` and lands on the card, even if the trial has since
// stopped selling; if the page itself is gone they go on to /trial. The editor
// preview shows the card disabled, sellable or not.

import { notFound, redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { resolveLocationBrand, resolveOrgChrome } from '@/lib/host-brand'
import { resolveGymSiteName } from '@/lib/default-site-name'
import { blocksOrDefault, pageCtas } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'
import RevealManager from '@/components/landing-page/RevealManager'
import JsonLd from '@/components/landing-page/JsonLd'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'
import { TRIAL_STUDIOS, loadTrialStudios } from '@/lib/trial-studios'
import { trialStudioView } from '@/lib/trial-studio-view'
import { parseTrialReturn, trialReturnPathFor } from '@/lib/trial-return-path'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

// Resolve a studio's landing row by its public_path. Joins the
// location for the display name (used in metadata). Returns null on
// miss so the page can 404 cleanly.
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

// TRIALFIRST.1 — this page's paid trial, if its studio sells one. Returns the
// client-safe studio view (`studio`, also built when nothing is for sale, so
// the editor preview can show the card) and, when the card is shown, the
// `trial` prop the hero renders it from. Shown = sellable, or a buyer coming
// back from a checkout (`resumePurchaseId`): a return always lands on the
// card, which then reads the purchase's own state, even when the trial has
// stopped selling or its config could not be read (resume overrides degrade).
// Only `trialStudioView` output and the un1t.online terms copy leave here.
async function loadPageTrial(db, { row, publicPath, brand, resumePurchaseId, cancelled }) {
  const known = TRIAL_STUDIOS.find((s) => s.publicPath === publicPath)
  if (!known) return { trial: null, trialShown: false, studio: null }
  const resuming = Boolean(resumePurchaseId)
  let entry
  try {
    const entries = await loadTrialStudios(db)
    entry = entries.find((e) => e.publicPath === publicPath)
  } catch {
    logWarn('studio-page', 'paid trial config unreadable; classic hero', { publicPath, locationId: row?.location_id || null, resuming })
    if (!resuming) return { trial: null, trialShown: false, studio: null }
  }
  if (!entry) entry = { key: known.key, publicPath, sellable: false, block: null, config: null }
  const studio = trialStudioView(entry, brand)
  const hatchTerms = entry.key === 'hatch' && studio.sellable
    ? un1tTermsPayload({ blocks: row.blocks, studioName: brand?.locationName || studio.label, publicPath })
    : null
  const trialShown = studio.sellable || resuming
  const trial = trialShown
    ? { studio, returnPath: trialReturnPathFor(publicPath), resumePurchaseId, cancelled, hatchTerms, preview: false }
    : null
  return { trial, trialShown, studio }
}

// W1.L4 — the OG site name is THIS studio's brand (company_settings →
// org_settings → location name) and the not-found title is the host's
// organisation brand; neither is a literal.
export async function generateMetadata(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  const hostBrand = await resolveGymSiteName({ host: (await headers()).get('host') })
  if (!row || !isPubliclyVisible(row.publish_state)) return { title: hostBrand }
  const blocks = blocksOrDefault(row.blocks)
  const hero = blocks.find((b) => b.type === 'hero')
  const heroImage = hero?.image_url || null
  const brand = (await resolveLocationBrand({ locationId: row.location_id })).companyName || hostBrand
  const studioName = row.locations?.name || brand
  const description = hero?.subtext
    || 'Coach-led strength + conditioning, built for racing. Book your free consultation.'
  const title = `${studioName} — Strength + conditioning, built for racing`
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: brand,
      type: 'website',
      ...(heroImage ? { images: [{ url: heroImage }] } : {}),
    },
  }
}

export default async function StudioLandingPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const row = await loadByPath(params.location)
  const { resumePurchaseId, cancelled } = parseTrialReturn(searchParams)

  // Public reachability gate. A page that isn't 'live' 404s for the public,
  // but the editor's live-preview iframe (?edit=1) still renders so the
  // operator can preview before publishing. A buyer coming back from a
  // checkout to a page that is gone is sent on to /trial, which can resume
  // any studio's purchase, rather than shown a 404 after paying.
  const isEditPreview = searchParams?.edit === '1'
  if (!row || (!isEditPreview && !isPubliclyVisible(row.publish_state))) {
    if (resumePurchaseId) {
      const key = params.location === 'hatch-street' ? 'hatch' : 'stillorgan'
      redirect(`/trial?purchase=${resumePurchaseId}&studio=${key}${cancelled ? '&cancelled=1' : ''}`)
    }
    notFound()
  }

  const blocks = blocksOrDefault(row.blocks)

  // Reviews carousel data — only query when the page has a reviews block.
  // One read for the page; the renderer filters/sizes in JS.
  let reviewsData = null
  const reviewsBlock = blocks.find((b) => b.type === 'reviews')
  if (reviewsBlock && row.location_id) {
    const db = createServerClient()
    const minRating = Number.isFinite(reviewsBlock.min_rating) ? reviewsBlock.min_rating : 4
    const { data: reviews } = await db.from('google_reviews')
      .select('id, google_review_id, rating, comment, author_name, author_photo_url, review_time, hidden')
      .eq('location_id', row.location_id)
      .eq('hidden', false)
      .gte('rating', minRating)
      .not('comment', 'is', null)
      .order('review_time', { ascending: false })
      .limit(30)
    reviewsData = { reviews: reviews || [] }
  }

  // W1.S1b — this studio's brand and its organisation's site chrome, both
  // from the per-location / per-org caches (host-brand.js): the logo alt and
  // name fall back to the studio's brand, the blocks' watermark to its
  // wordmark, the footer to the org's brand, live studios and legal name.
  const [brand, chrome] = await Promise.all([
    resolveLocationBrand({ locationId: row.location_id }),
    resolveOrgChrome({ orgId: row.locations?.organization_id || null }),
  ])
  const footer = { brand: chrome.companyName, studios: chrome.studios, legalName: chrome.legalName }

  const { trial, trialShown, studio } = await loadPageTrial(createServerClient(), {
    row,
    publicPath: params.location,
    brand,
    resumePurchaseId: isEditPreview ? null : resumePurchaseId,
    cancelled: isEditPreview ? false : cancelled,
  })

  const logoUrl     = row.logo_url || null
  const logoAlt     = row.logo_alt || brand.companyName
  const logoWidthPx = row.logo_width_px || 200

  // Edit-mode preview (LP multi-page). The /settings/landing-page editor
  // loads THIS studio's page with ?edit=1 in its preview iframe; mount
  // the postMessage-driven overlay seeded from this studio's content so
  // the preview reflects the studio being edited.
  if (isEditPreview) {
    return (
      <EditModeOverlay
        initialBlocks={blocks}
        initialLogoUrl={logoUrl}
        initialLogoAlt={logoAlt}
        initialLogoWidthPx={logoWidthPx}
        fallbackLogoAlt={brand.companyName}
        wordmark={brand.shortName}
        locationName={brand.locationName}
        footer={footer}
        trialPreview={studio
          ? { studio, returnPath: trialReturnPathFor(params.location), resumePurchaseId: null, cancelled: false, hatchTerms: trial?.hatchTerms ?? null, preview: true }
          : null}
      />
    )
  }

  const { primary: cta, secondary: cta2 } = pageCtas(blocks, { trialShown })
  const studioName = row.locations?.name || brand.companyName
  const hero = blocks.find((b) => b.type === 'hero')
  // The card lives in the first hero only (one #trial on the page). A page
  // with no hero gets a render-only one so the card always has a home; it is
  // never saved to the row.
  const rendered = trialShown && !hero ? [{ id: 'hero-trial', type: 'hero' }, ...blocks] : blocks
  const trialHero = trialShown ? rendered.find((b) => b.type === 'hero') : null

  // Gym structured data — name, url, hero image. No aggregateRating:
  // it was sourced from the Google Business Profile sync, retired in
  // mig 410 (reviews are populated manually now; never invent one).
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Gym',
    name: studioName,
    url: `https://un1tdublin.com/${params.location}`,
    ...(hero?.image_url ? { image: hero.image_url } : {}),
    ...(logoUrl ? { logo: logoUrl } : {}),
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
        wordmark={brand.shortName}
        sticky
        ctaHref={cta?.href || null}
        ctaLabel={cta?.label}
        ctaLabelShort={cta?.labelShort || ''}
        eventsHref={`/${row.public_path}/events`}
      />
      {rendered.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={params.location}
          reviewsData={reviewsData}
          ctaHref={cta?.href || null}
          ctaLabel={cta?.label}
          ctaSecondaryHref={cta2?.href || null}
          ctaSecondaryLabel={cta2?.label}
          wordmark={brand.shortName}
          locationName={brand.locationName}
          trial={block === trialHero ? trial : null}
          trialShown={trialShown}
        />
      ))}
      <SiteFooter ctaHref={cta?.href || (trialShown ? '#trial' : '#book')} ctaLabel={cta?.label || 'Book a free consult'} {...footer} />
    </div>
  )
}
