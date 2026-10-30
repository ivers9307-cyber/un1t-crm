// /50plus — FIFTYPLUS.1: the Meta-ad landing page for The 50+ Club at UN1T
// Stillorgan. One class (THE 50+ CLUB, Mon/Wed/Fri 11:00), one trial plan
// (The Elites Trial): the coach video, the three mornings as date tiles,
// details, booked. Everything the page says, the video, the class filter and
// the plan come from the `campaign_funnel` block (campaign '50plus') on
// Stillorgan's landing row, edited at /settings/landing-page; the page is
// code because landing rows are one per studio.
//
// Light page (the reader is 55-70 on a phone): white chrome, the pale card,
// type a step up from /trial. Below the fold: the "what to expect" strip,
// then the row's existing sections the block chose (stats, member videos,
// reviews) in the light tone, then the footer. The video box is the one dark
// island.
//
// Graceful: an unreadable row still renders the hero and the card on the
// block's defaults (the card then says booking is not open), never a 404 for
// paid traffic. Allowlisted on the proxy, AppShell and the un1t-marketing
// brand (UN1T-only like /start and /trial: pinned off tenant hosts in
// src/public-compliance-paths.test.jsx). noindex: a paid funnel should not
// compete in organic search. The site Meta pixel loads everywhere; the server
// Lead goes to Stillorgan's dataset (the same one).
//
// Design: docs/superpowers/specs/2026-10-30-50plus-landing-page-design.md.

import { createServerClient } from '@/lib/supabase'
import { campaignFunnelBlock, campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import CampaignFunnel from '@/components/landing-page/CampaignFunnel'
import CampaignHero from '@/components/landing-page/CampaignHero'
import ExpectStrip from '@/components/landing-page/ExpectStrip'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

const CAMPAIGN = '50plus'
const PUBLIC_PATH = 'stillorgan'
const STILLORGAN_LOCATION_ID = 'a0000000-0000-0000-0000-000000000001'
const CTA_HREF = '#book'
const CTA_LABEL = 'Book a free class'

export async function generateMetadata() {
  const chrome = await resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID })
  const name = chrome.companyName
  return {
    // Customer-visible (the tab, a share): no em-dash (CLAUDE.md).
    title: name ? `The 50+ Club Trial at ${name}` : 'The 50+ Club Trial',
    description: 'A free trial of The 50+ Club at UN1T Stillorgan. Coach-led strength for the over-50s, three mornings a week. Pick your first class.',
    robots: { index: false, follow: false },
  }
}

// The Stillorgan row: the campaign block and the sections it may show.
// Graceful: any miss → no block (the defaults render), no sections.
async function loadRow(db) {
  try {
    const { data, error } = await db.from('landing_page_settings')
      .select('location_id, public_path, blocks').eq('public_path', PUBLIC_PATH).maybeSingle()
    if (error) throw error
    return { locationId: data?.location_id || STILLORGAN_LOCATION_ID, blocks: Array.isArray(data?.blocks) ? data.blocks : [] }
  } catch (e) {
    logWarn('50plus-page', 'landing row unreadable; defaults only', { err: e })
    return { locationId: STILLORGAN_LOCATION_ID, blocks: [] }
  }
}

// Reviews carousel data, only when the block chose the reviews section
// (the same read src/app/welcome/[location]/page.js does).
async function loadReviews(db, locationId, reviewsBlock) {
  if (!reviewsBlock) return null
  try {
    const minRating = Number.isFinite(reviewsBlock.min_rating) ? reviewsBlock.min_rating : 4
    const { data: reviews, error } = await db.from('google_reviews')
      .select('id, google_review_id, rating, comment, author_name, author_photo_url, review_time, hidden')
      .eq('location_id', locationId)
      .eq('hidden', false)
      .gte('rating', minRating)
      .not('comment', 'is', null)
      .order('review_time', { ascending: false })
      .limit(30)
    if (error) throw error
    return { reviews: reviews || [] }
  } catch (e) {
    logWarn('50plus-page', 'reviews unreadable; section skipped', { err: e })
    return null
  }
}

export default async function FiftyPlusPage() {
  const db = createServerClient()
  const [row, logoUrl, chrome, studio] = await Promise.all([
    loadRow(db),
    getLandingLogo(PUBLIC_PATH, STILLORGAN_LANDING_LOGO),
    resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID }),
    resolveLocationBrand({ locationId: STILLORGAN_LOCATION_ID }),
  ])
  const studioName = studio.companyName || chrome.companyName
  const block = campaignFunnelBlock(row.blocks, CAMPAIGN)
  const copy = campaignFunnelCopy(block || {}, { brand: studioName })
  const clientCopy = campaignFunnelClientCopy(copy)

  // The sections the block chose, each the row's first block of that type.
  const sections = copy.show_sections
    .map((type) => row.blocks.find((b) => b && typeof b === 'object' && b.type === type))
    .filter(Boolean)
  const reviewsData = await loadReviews(db, row.locationId, sections.find((b) => b.type === 'reviews'))

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <SiteHeader logoUrl={logoUrl} logoAlt={studioName} logoWidthPx={150} sticky ctaHref={CTA_HREF} ctaLabel={CTA_LABEL} />

      <CampaignHero
        videoUrl={copy.video_url}
        posterUrl={copy.poster_url}
        soundLabel={copy.sound_label}
        eyebrow={copy.eyebrow}
        heading={copy.heading}
        subhead={copy.subhead}
      >
        <CampaignFunnel publicPath={PUBLIC_PATH} campaign={CAMPAIGN} copy={clientCopy} locationName={studioName} />
      </CampaignHero>

      <ExpectStrip eyebrow={copy.expect_eyebrow} heading={copy.expect_heading} cards={copy.expect_cards} />

      {sections.map((b) => (
        <BlockRenderer
          key={b.id || b.type}
          block={b}
          tone="light"
          publicPath={PUBLIC_PATH}
          reviewsData={reviewsData}
          ctaHref={CTA_HREF}
          ctaLabel={CTA_LABEL}
          wordmark={chrome.shortName}
          locationName={studioName}
        />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={CTA_LABEL} brand={chrome.companyName} studios={chrome.studios} legalName={chrome.legalName} />
    </div>
  )
}
