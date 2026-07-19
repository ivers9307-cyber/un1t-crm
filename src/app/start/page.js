// /start — public Meta-ad landing page (Stillorgan). A full landing page that
// mirrors the welcome-page layout: a hero (Ken Burns push-in + bottom-weighted
// scrim + film grain, lp-* classes from globals.css) with the StartFunnel
// booking flow as a frosted card in place of the usual headline/CTA, followed
// by the rest of the Hatch Street page's content blocks (video testimonials,
// pillars, stats, testimonial) rendered through the shared BlockRenderers, a
// sticky header + footer whose CTA scrolls back up to the funnel.
//
// Content source: the Hatch Street landing row (the page we're matching). Hero
// + lead_form are dropped — the funnel hero replaces both (the funnel IS the
// lead capture). Stillorgan's own landing has no hero image, so the hero photo
// is Hatch's; swap HERO_IMAGE to change it. Allowlisted in brands.js
// (un1t-marketing) + proxy.js + AppShell. noindex: a paid funnel shouldn't
// compete in organic search.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import StartFunnel from '@/components/StartFunnel'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'

export const dynamic = 'force-dynamic'

// SAAS-7 — the header logo resolves from Stillorgan's
// landing_page_settings row (the operator-editable source /stillorgan
// itself renders) with the old hardcoded URL as fallback; live value is
// identical today, so paid traffic sees no change.

const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'

// CTA everywhere on the page just scrolls back up to the funnel.
const CTA_HREF = '#start'
const CTA_LABEL = 'Claim 3 free classes'

export const metadata = {
  title: '3 Free Classes — UN1T Stillorgan',
  description: 'Your first 3 classes at UN1T Stillorgan are free — coach-led strength & conditioning. Book your first session now.',
  robots: { index: false, follow: false },
}

// The Hatch Street page's content sections, minus its hero + lead_form (the
// funnel hero replaces both). Graceful: any miss → just the hero renders.
async function loadContentBlocks() {
  try {
    const db = createServerClient()
    const { data } = await db
      .from('landing_page_settings')
      .select('blocks')
      .eq('public_path', 'hatch-street')
      .maybeSingle()
    return blocksOrDefault(data?.blocks).filter((b) => b.type !== 'hero' && b.type !== 'lead_form')
  } catch {
    return []
  }
}

export default async function StartPage() {
  const [blocks, logoUrl] = await Promise.all([
    loadContentBlocks(),
    getLandingLogo('stillorgan', STILLORGAN_LANDING_LOGO),
  ])
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={logoUrl}
        logoAlt="UN1T Stillorgan"
        logoWidthPx={150}
        sticky
        ctaHref={CTA_HREF}
        ctaLabel={CTA_LABEL}
      />

      <section id="start" className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
        {/* Hero backdrop: slow Ken Burns push-in + a bottom-weighted scrim so the
            frosted funnel card always carries over the image. */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${HERO_IMAGE})` }} />
        </div>
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }}
        />

        <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-28 pb-16">
          <StartFunnel />
        </div>
      </section>

      {blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath="stillorgan"
          ctaHref={CTA_HREF}
          ctaLabel={CTA_LABEL}
        />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={CTA_LABEL} />
    </div>
  )
}
