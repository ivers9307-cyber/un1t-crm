// CORPPROMO.1 — the shared body of /corp and /corp/<promo>: the /trial layout
// (hero photo, frosted card, then the studio's landing sections), with the
// claim card for one promo. The studio, credits and expiry are the registry's
// (src/lib/corp-promos.js); the words are the studio's corp_promo block, with
// {studio_name} and {credits} filled here ({expires_on} only after a claim).
// A promo that is unknown, switched off or whose studio cannot be read shows
// "not available right now", never a 404 or a 500 for a shared link.
import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import { resolveCorpPromo, liveCorpPromos, corpPromoCopyFromBlocks, fillCorpPromoTokens, CORP_PROMO_COPY_DEFAULT } from '@/lib/corp-promos'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import CorpPromoFunnel from '@/components/landing-page/CorpPromoFunnel'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { logWarn } from '@/lib/log'

const NOT_CONTENT = ['hero', 'lead_form', 'class_funnel', 'paid_trial', 'corp_promo']
const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'
const CTA_HREF = '#corp'

export const corpMetadata = {
  title: 'Corporate offer',
  description: 'A free offer for our partner companies. Claim it in under a minute.',
  robots: { index: false, follow: false },
}

/** The live promo for `key` (null = the first live one), or null. */
export function pickPromo(key) {
  if (key == null) return liveCorpPromos()[0] ?? null
  const p = resolveCorpPromo(key)
  return p && p.live ? p : null
}

async function loadStudio(db, promo) {
  try {
    const { data, error } = await db.from('landing_page_settings')
      .select('location_id, blocks').eq('public_path', promo.publicPath).maybeSingle()
    if (error) throw error
    return data?.location_id ? data : null
  } catch (e) {
    logWarn('corp-page', 'landing row unreadable; offer shown as not available', { promo: promo.key, code: e?.code ?? null })
    return null
  }
}

export default async function CorpPage({ promoKey = null }) {
  const promo = pickPromo(promoKey)
  const db = createServerClient()
  const [studio, logoUrl, chrome] = await Promise.all([
    promo ? loadStudio(db, promo) : null,
    getLandingLogo('hatch-street', STILLORGAN_LANDING_LOGO),
    resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID }),
  ])
  const brand = studio ? await resolveLocationBrand({ locationId: studio.location_id }) : null
  const studioName = brand?.locationName || brand?.companyName || ''
  const raw = studio ? corpPromoCopyFromBlocks(studio.blocks, promo.key) : { ...CORP_PROMO_COPY_DEFAULT, ticks: [...CORP_PROMO_COPY_DEFAULT.ticks] }
  const tokens = { studio_name: studioName, credits: promo?.credits ?? '' }
  const copy = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.map((t) => fillCorpPromoTokens(t, tokens)) : fillCorpPromoTokens(v, tokens)]))
  const terms = studio ? un1tTermsPayload({ blocks: studio.blocks, studioName, publicPath: promo.publicPath }) : null
  const blocks = studio ? blocksOrDefault(studio.blocks).filter((b) => !NOT_CONTENT.includes(b.type)) : []
  const ctaLabel = copy.cta_label

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <SiteHeader logoUrl={logoUrl} logoAlt={chrome.companyName || studioName} logoWidthPx={150} sticky ctaHref={CTA_HREF} ctaLabel={ctaLabel} />

      <section id="corp" className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${HERO_IMAGE})` }} />
        </div>
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
          style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }} />
        <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-28 pb-16">
          <CorpPromoFunnel promoKey={promo && studio ? promo.key : null} copy={copy} terms={terms} />
        </div>
      </section>

      {blocks.map((b) => (
        <BlockRenderer key={b.id} block={b} publicPath={promo?.publicPath} ctaHref={CTA_HREF} ctaLabel={ctaLabel} wordmark={chrome.shortName} locationName={studioName} />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={ctaLabel} brand={chrome.companyName} studios={chrome.studios} legalName={chrome.legalName} />
    </div>
  )
}
