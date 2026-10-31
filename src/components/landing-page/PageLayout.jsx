// PAGES.1 — the three page layouts of the one public page route
// (src/app/(public)/[slug]/[[...rest]]/page.js). Which one renders is
// `layoutFor(page.offer_type)` (src/lib/landing-page-render.js). The JSX is
// lifted from the code routes these replace, unchanged in look:
//
//   FrostedCardLayout  /trial (and /corp, /start/[path]): the hero photo with
//                      the offer card as a frosted panel, then the content
//                      blocks, every CTA scrolling back up to the card.
//   OneClassLayout     /50plus: CampaignHero (coach video + the funnel), the
//                      expect strip, then the content blocks, on the page tone.
//   BlocksLayout       header, the blocks in order, footer. A studio page
//                      (/stillorgan) always takes this one: TRIALFIRST's buy
//                      card rides in its first hero (the old /welcome/[location]).
//
// Server components. Every prop is already client-safe: the route builds the
// offer card (`offer`, a React node) from the client-view helpers, and the
// blocks are the page's own content blocks.
//
// Props, shared by all three:
//   tone        'dark' | 'light' (page.chrome.tone; default 'dark')
//   logo        { url, alt, widthPx, wordmark }   SiteHeader
//   cta         { href, label }                   header, blocks, footer
//   footer      { brand, studios, legalName }     SiteFooter
//   blocks      content blocks, in order          BlockRenderer
//   blockProps  { publicPath, page, wordmark, locationName, reviewsData }, passed
//               to every BlockRenderer with `tone`, `ctaHref`, `ctaLabel`
// FrostedCardLayout also takes:
//   anchor        the card section's id (the CTA target, without '#')
//   heroImageUrl  the photo behind the card
//   offer         the card
//   scrollCueLabel the cue under the card pointing at the blocks, or null
// OneClassLayout also takes:
//   hero    { videoUrl, posterUrl, soundLabel, eyebrow, heading, subhead }
//   offer   the funnel, rendered inside the hero
//   expect  { eyebrow, heading, cards }  ExpectStrip
// BlocksLayout also takes (a studio page's; each default leaves a campaign
// page's markup as it was):
//   cta.labelShort  the header's short CTA label ('' = cta.label)
//   cta2        { href, label } the secondary CTA (hero, lead form), or null
//   eventsHref  the header's Events link, or null
//   trial       the paid trial card's props for the FIRST hero
//               ({ studio, returnPath, resumePurchaseId, cancelled,
//               hatchTerms, preview }), or null
//   trialShown  the card is on the page: the lead form compacts, a page with
//               no hero gets a render-only one for the card, and the footer
//               CTA falls back to '#trial'
//   jsonLd      a schema.org node (JsonLd island), or null

import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import CampaignHero from '@/components/landing-page/CampaignHero'
import ExpectStrip from '@/components/landing-page/ExpectStrip'
import FrostedHero, { learnMoreIdFor } from '@/components/landing-page/FrostedHero'
import JsonLd from '@/components/landing-page/JsonLd'

const shellClass = (tone) => (tone === 'light'
  ? 'min-h-screen bg-white text-black antialiased'
  : 'min-h-screen bg-black text-white antialiased')

// HEROHEADER.1 — `tone` colours the fixed bar for the page; `showCta` false
// drops the header button (OneClassLayout: the booking card IS the page's
// call to action and sits in the hero beside the video, so a second "Book a
// free class" in the corner only competed with it).
function Header({ logo = {}, cta = {}, eventsHref = null, tone = 'dark', showCta = true }) {
  return (
    <SiteHeader
      logoUrl={logo.url || null}
      logoAlt={logo.alt || ''}
      logoWidthPx={logo.widthPx || 150}
      wordmark={logo.wordmark || ''}
      sticky
      tone={tone}
      ctaHref={showCta ? (cta.href || null) : null}
      ctaLabel={cta.label}
      ctaLabelShort={cta.labelShort || ''}
      eventsHref={eventsHref}
    />
  )
}

function Footer({ footer = {}, cta = {}, fallbackHref = '#book' }) {
  return <SiteFooter ctaHref={cta.href || fallbackHref} ctaLabel={cta.label || 'Book a free consult'} brand={footer.brand || ''} studios={footer.studios || []} legalName={footer.legalName || ''} />
}

// `trial` goes to `trialHero` only (one card, one #trial); `cta2` and the
// trial props are passed only when given, so a campaign page's blocks get
// exactly the props they always did.
function Blocks({ blocks = [], blockProps = {}, cta = {}, cta2 = null, tone, trial = null, trialShown = false, trialHero = null }) {
  return blocks.map((b, i) => (
    <BlockRenderer
      key={b.id || `${b.type}-${i}`}
      block={b}
      tone={tone}
      publicPath={blockProps.publicPath}
      page={blockProps.page || null}
      reviewsData={blockProps.reviewsData || null}
      ctaHref={cta.href || null}
      ctaLabel={cta.label}
      wordmark={blockProps.wordmark || ''}
      locationName={blockProps.locationName || ''}
      {...(cta2 ? { ctaSecondaryHref: cta2.href || null, ctaSecondaryLabel: cta2.label } : {})}
      {...(trialShown ? { trial: b === trialHero ? trial : null, trialShown: true } : {})}
    />
  ))
}

// PAGES.1 — `pageLocationId` is the studio the page speaks for, stamped on the
// root element as `data-page-location` so the browser's Meta pixel code
// (pageLocationIdFromDocument) can load that studio's dataset without a round trip.
export function FrostedCardLayout({ tone = 'dark', logo, cta, footer, blocks = [], blockProps, anchor = 'offer', heroImageUrl = null, offer = null, scrollCueLabel = null, pageLocationId = null }) {
  const learnMoreId = learnMoreIdFor(anchor)
  return (
    <div className={shellClass(tone)} data-page-location={pageLocationId || undefined}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <Header logo={logo} cta={cta} tone={tone} />

      <FrostedHero anchor={anchor} heroImageUrl={heroImageUrl} offer={offer} scrollCueLabel={scrollCueLabel} />

      <div id={learnMoreId} className="scroll-mt-20">
        <Blocks blocks={blocks} blockProps={blockProps} cta={cta} tone={tone} />
      </div>

      <Footer footer={footer} cta={cta} />
    </div>
  )
}

export function OneClassLayout({ tone = 'light', logo, cta, footer, blocks = [], blockProps, hero = {}, offer = null, expect = {}, pageLocationId = null }) {
  return (
    <div className={shellClass(tone)} data-page-location={pageLocationId || undefined}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <Header logo={logo} cta={cta} tone={tone} showCta={false} />

      <CampaignHero
        videoUrl={hero.videoUrl}
        posterUrl={hero.posterUrl}
        soundLabel={hero.soundLabel}
        videoFocus={hero.videoFocus}
        soundDefault={hero.soundDefault}
        eyebrow={hero.eyebrow}
        heading={hero.heading}
        subhead={hero.subhead}
      >
        {offer}
      </CampaignHero>

      <ExpectStrip eyebrow={expect.eyebrow} heading={expect.heading} cards={expect.cards} />

      <Blocks blocks={blocks} blockProps={blockProps} cta={cta} tone={tone} />

      <Footer footer={footer} cta={cta} />
    </div>
  )
}

export function BlocksLayout({ tone = 'dark', logo, cta, footer, blocks = [], blockProps, cta2 = null, eventsHref = null, trial = null, trialShown = false, jsonLd = null, pageLocationId = null }) {
  // TRIALFIRST.1 — the card lives in the first hero only (one #trial on the
  // page); a page with no hero gets a render-only one so the card always has
  // a home. It is never saved to the row.
  const shownTrial = Boolean(trialShown)
  const hasHero = blocks.some((b) => b?.type === 'hero')
  const rendered = shownTrial && !hasHero ? [{ id: 'hero-trial', type: 'hero' }, ...blocks] : blocks
  const trialHero = shownTrial ? rendered.find((b) => b?.type === 'hero') : null
  return (
    <div className={shellClass(tone)} data-page-location={pageLocationId || undefined}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      <Header logo={logo} cta={cta} eventsHref={eventsHref} tone={tone} />
      <Blocks blocks={rendered} blockProps={blockProps} cta={cta} cta2={cta2} tone={tone} trial={trial} trialShown={shownTrial} trialHero={trialHero} />
      <Footer footer={footer} cta={cta} fallbackHref={shownTrial ? '#trial' : '#book'} />
    </div>
  )
}
