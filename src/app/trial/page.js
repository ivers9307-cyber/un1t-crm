// /trial — PAIDTRIAL.1: the public Meta-ad product page for Stillorgan's paid
// two-week trial. Same layout as /start (the paid-ad twin): a hero photo with
// the product card as a frosted panel, then the content blocks, with every
// CTA scrolling back up to the card. The product (copy, price, duration, the
// Glofox plan granted after payment) is Stillorgan's paid_trial landing block,
// edited at /settings/landing-page; without a sellable block the card says
// the trial is not available online, never a 404 for paid traffic.
//
// Allowlisted on the proxy, AppShell and the un1t-marketing brand (UN1T-only,
// like /start: not served on tenant hosts, pinned in
// src/public-compliance-paths.test.jsx). noindex: a paid funnel should not
// compete in organic search. The site Meta pixel loads here by default
// (Stillorgan's ads run from the UN1T Dublin business); the server sends
// Lead and Purchase to settings.meta_ads.dataset_id of the location.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import { paidTrialConfigFromBlocks } from '@/lib/paid-trial'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import PaidTrialFunnel from '@/components/landing-page/PaidTrialFunnel'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

const STILLORGAN_LOCATION_ID = 'a0000000-0000-0000-0000-000000000001'
const PUBLIC_PATH = 'stillorgan'
const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'
const CTA_HREF = '#trial'

export const metadata = {
  title: 'The UN1T 14 Day Reset — UN1T Stillorgan',
  description: 'The UN1T 14 Day Reset: two weeks of unlimited coach-led classes at UN1T Stillorgan for €39. Pay once, start this week.',
  robots: { index: false, follow: false },
}

// The product block off Stillorgan's row, and the page's content sections
// (its own if it has any beyond the product, else the Hatch Street sections
// /start uses). Graceful: any miss → the hero and the card still render.
async function loadPage() {
  const db = createServerClient()
  let block = null
  let product = null
  let blocks = []
  try {
    const { data } = await db.from('landing_page_settings').select('blocks').eq('public_path', PUBLIC_PATH).maybeSingle()
    const own = blocksOrDefault(data?.blocks)
    block = own.find((b) => b.type === 'paid_trial') || null
    product = paidTrialConfigFromBlocks(data?.blocks, PUBLIC_PATH)
    const content = own.filter((b) => !['hero', 'lead_form', 'class_funnel', 'paid_trial'].includes(b.type))
    if (content.length > 0) blocks = content
    else {
      const { data: hatch } = await db.from('landing_page_settings').select('blocks').eq('public_path', 'hatch-street').maybeSingle()
      blocks = blocksOrDefault(hatch?.blocks).filter((b) => !['hero', 'lead_form', 'class_funnel', 'paid_trial'].includes(b.type))
    }
  } catch (e) {
    logWarn('trial-page', 'landing rows unreadable; hero and card only', { err: e })
  }
  return { block, product, blocks }
}

export default async function TrialPage(props) {
  const sp = await props.searchParams
  const resumePurchaseId = typeof sp?.purchase === 'string' && /^[0-9a-f-]{36}$/i.test(sp.purchase) ? sp.purchase : null
  const [{ block, product, blocks }, logoUrl, chrome, studio] = await Promise.all([
    loadPage(),
    getLandingLogo('stillorgan', STILLORGAN_LANDING_LOGO),
    resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID }),
    resolveLocationBrand({ locationId: STILLORGAN_LOCATION_ID }),
  ])
  const studioName = studio.companyName || chrome.companyName
  // The card needs a block for its copy even when nothing is sellable yet.
  const cardBlock = block || { heading: 'The UN1T 14 Day Reset', price_cents: 0, currency: 'EUR', duration_days: 14, ticks: [] }
  const ctaLabel = block?.cta_label || 'Start my 14 Day Reset'

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <SiteHeader logoUrl={logoUrl} logoAlt={studioName} logoWidthPx={150} sticky ctaHref={CTA_HREF} ctaLabel={ctaLabel} />

      <section id="trial" className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${HERO_IMAGE})` }} />
        </div>
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
          style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }} />
        <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-28 pb-16">
          <PaidTrialFunnel block={cardBlock} publicPath={PUBLIC_PATH} resumePurchaseId={resumePurchaseId} sellable={Boolean(product)} />
        </div>
      </section>

      {blocks.map((b) => (
        <BlockRenderer key={b.id} block={b} publicPath={PUBLIC_PATH} ctaHref={CTA_HREF} ctaLabel={ctaLabel} wordmark={chrome.shortName} locationName={studioName} />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={ctaLabel} brand={chrome.companyName} studios={chrome.studios} legalName={chrome.legalName} />
    </div>
  )
}
