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
//   BlocksLayout       header, the blocks in order, footer.
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

import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import CampaignHero from '@/components/landing-page/CampaignHero'
import ExpectStrip from '@/components/landing-page/ExpectStrip'
import FrostedHero, { learnMoreIdFor } from '@/components/landing-page/FrostedHero'

const shellClass = (tone) => (tone === 'light'
  ? 'min-h-screen bg-white text-black antialiased'
  : 'min-h-screen bg-black text-white antialiased')

function Header({ logo = {}, cta = {} }) {
  return (
    <SiteHeader
      logoUrl={logo.url || null}
      logoAlt={logo.alt || ''}
      logoWidthPx={logo.widthPx || 150}
      wordmark={logo.wordmark || ''}
      sticky
      ctaHref={cta.href || null}
      ctaLabel={cta.label}
    />
  )
}

function Footer({ footer = {}, cta = {} }) {
  return <SiteFooter ctaHref={cta.href || '#book'} ctaLabel={cta.label || 'Book a free consult'} brand={footer.brand || ''} studios={footer.studios || []} legalName={footer.legalName || ''} />
}

function Blocks({ blocks = [], blockProps = {}, cta = {}, tone }) {
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
    />
  ))
}

export function FrostedCardLayout({ tone = 'dark', logo, cta, footer, blocks = [], blockProps, anchor = 'offer', heroImageUrl = null, offer = null, scrollCueLabel = null }) {
  const learnMoreId = learnMoreIdFor(anchor)
  return (
    <div className={shellClass(tone)}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <Header logo={logo} cta={cta} />

      <FrostedHero anchor={anchor} heroImageUrl={heroImageUrl} offer={offer} scrollCueLabel={scrollCueLabel} />

      <div id={learnMoreId} className="scroll-mt-20">
        <Blocks blocks={blocks} blockProps={blockProps} cta={cta} tone={tone} />
      </div>

      <Footer footer={footer} cta={cta} />
    </div>
  )
}

export function OneClassLayout({ tone = 'light', logo, cta, footer, blocks = [], blockProps, hero = {}, offer = null, expect = {} }) {
  return (
    <div className={shellClass(tone)}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <Header logo={logo} cta={cta} />

      <CampaignHero
        videoUrl={hero.videoUrl}
        posterUrl={hero.posterUrl}
        soundLabel={hero.soundLabel}
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

export function BlocksLayout({ tone = 'dark', logo, cta, footer, blocks = [], blockProps }) {
  return (
    <div className={shellClass(tone)}>
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <Header logo={logo} cta={cta} />
      <Blocks blocks={blocks} blockProps={blockProps} cta={cta} tone={tone} />
      <Footer footer={footer} cta={cta} />
    </div>
  )
}
