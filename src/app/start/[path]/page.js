// /start/[path] — a studio's dedicated class-booking page, the paid-ad twin
// of /start (which stays Stillorgan's, unchanged). MANUALFUNNEL.1.
//
// Same layout as /start: the ClassFunnel as a frosted card over the hero
// photo, then the studio's own content blocks, with every CTA scrolling back
// up to the funnel. The difference is where it reads from: everything here
// comes off the studio's OWN landing_page_settings row, resolved by
// public_path, so /start/hatch-street shows Hatch Street's photo, logo,
// sections and funnel copy and books against Hatch Street's timetable.
//
// The page needs a class_funnel block on that row: its copy is the funnel's
// copy and (for a studio with no Glofox) its timetable is the class list. A
// row without one 404s. The block's "Show on the main landing page" switch
// only governs /{path}; this page always renders the funnel.
//
// Public reachability: '/start' is already on all four allowlists, each of
// which matches this nested path (proxy.js and brands.js by startsWith,
// AppShell by segment). noindex, like /start: a paid funnel should not
// compete with the studio's main page in organic search.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import ClassFunnel from '@/components/ClassFunnel'
import { resolveLandingPath, classFunnelCtaLabel } from '@/lib/public-landing'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'

export const dynamic = 'force-dynamic'

// CTA everywhere on the page just scrolls back up to the funnel.
const CTA_HREF = '#start'

// Columns are named: the row carries more than this page needs, and the
// blocks go on to client components.
async function loadByPath(rawPath) {
  const path = resolveLandingPath(rawPath)
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('location_id, public_path, publish_state, blocks, logo_url, logo_alt, logo_width_px, locations:location_id ( name )')
      .eq('public_path', path)
      .maybeSingle()
    if (error || !data) return null
    if (!isPubliclyVisible(data.publish_state)) return null
    const blocks = blocksOrDefault(data.blocks)
    const funnel = blocks.find((b) => b.type === 'class_funnel')
    if (!funnel) return null
    return { row: data, path, blocks, funnel }
  } catch {
    return null
  }
}

export async function generateMetadata(props) {
  const params = await props.params
  const page = await loadByPath(params.path)
  const robots = { index: false, follow: false }
  if (!page) return { title: 'UN1T Dublin', robots }
  const studioName = page.row.locations?.name || 'UN1T Dublin'
  const heading = (typeof page.funnel.heading === 'string' && page.funnel.heading.trim()) || 'Book a class'
  return {
    title: `${heading} | ${studioName}`,
    description: (typeof page.funnel.subhead === 'string' && page.funnel.subhead.trim()) || undefined,
    robots,
  }
}

export default async function StudioStartPage(props) {
  const params = await props.params
  const page = await loadByPath(params.path)
  if (!page) notFound()
  const { row, path, blocks, funnel } = page

  const hero = blocks.find((b) => b.type === 'hero')
  const heroImage = typeof hero?.image_url === 'string' && hero.image_url ? hero.image_url : null
  const ctaLabel = classFunnelCtaLabel(blocks)
  // The funnel hero replaces the page's own hero and capture blocks: the
  // funnel IS the lead capture here.
  const content = blocks.filter((b) => b.type !== 'hero' && b.type !== 'lead_form' && b.type !== 'class_funnel')

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={row.logo_url || null}
        logoAlt={row.logo_alt || row.locations?.name || 'UN1T Dublin'}
        logoWidthPx={row.logo_width_px || 150}
        sticky
        ctaHref={CTA_HREF}
        ctaLabel={ctaLabel}
      />

      <section id="start" className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
        {heroImage && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${heroImage})` }} />
          </div>
        )}
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }}
        />

        <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-28 pb-16">
          <ClassFunnel
            publicPath={path}
            // '' is "no consult upsell" and must be passed explicitly: an
            // absent prop falls back to Stillorgan's booking type.
            consultSlug={funnel.consult_slug || ''}
            heading={funnel.heading}
            subhead={funnel.subhead}
            consentLabel={funnel.consent_label}
            classDoneTitle={funnel.class_done_title}
            classDoneBody={funnel.class_done_body}
            consultDoneTitle={funnel.consult_done_title}
            consultDoneBody={funnel.consult_done_body}
          />
        </div>
      </section>

      {content.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={path}
          ctaHref={CTA_HREF}
          ctaLabel={ctaLabel}
        />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={ctaLabel} />
    </div>
  )
}
