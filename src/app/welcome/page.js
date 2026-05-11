// /welcome — public marketing landing page (Phase 3c iframe-aware).
//
// Two render modes:
//   1. Public (default) — server-rendered from landing_page_settings.
//      Top nav + ordered blocks + footer. Same as Phase 3b.
//   2. Edit (?edit=1)    — mounts the EditModeOverlay client component,
//      which receives state from the parent settings page via
//      postMessage and re-renders on every keystroke. Used as the
//      live preview iframe inside /settings/landing-page.
//
// The block rendering logic lives in src/components/landing-page/
// BlockRenderers.jsx so both modes (and any future mode like a
// printable PDF version) render identically.
//
// Adding a new block type: register it in src/lib/landing-page-
// blocks.js, add a case to BlockRenderer in BlockRenderers.jsx,
// add an edit panel in LandingPageSettingsForm.jsx. Three-file
// change, no schema migration.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'

// Today UN1T has one marketing-active location. Multi-location
// hostname routing is a future Phase — for now take the most
// recently-updated row so whichever location's owner last edited
// the page wins.
async function loadSettings() {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return null
    return data || null
  } catch {
    // Never let a settings fetch failure 500 the public marketing
    // page — degrade silently to defaults. The /welcome page is the
    // top of the funnel; brokenness here costs us leads.
    return null
  }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Per-request metadata. Pull og:image from the first hero block's
// image (operator-uploaded photos show up in WhatsApp / Slack link
// previews). Title + description stay on SEO-stable strings to
// avoid an operator accidentally tanking search rank with a pithy
// headline.
export async function generateMetadata() {
  const row = await loadSettings()
  const blocks = blocksOrDefault(row?.blocks)
  const hero = blocks.find((b) => b.type === 'hero')
  const heroImage = hero?.image_url || null
  const description = hero?.subtext
    || 'Coach-led training for athletes and ambitious beginners. Hyrox-style strength + conditioning at our Stillorgan studio. Book your free consultation.'
  const title = 'UN1T Dublin — Strength + conditioning, built for racing'
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

export default async function WelcomePage({ searchParams }) {
  const row = await loadSettings()
  const blocks = blocksOrDefault(row?.blocks)
  // Site chrome (mig 129) — logo lives outside the blocks array
  // because it always renders regardless of section ordering.
  const logoUrl     = row?.logo_url || null
  const logoAlt     = row?.logo_alt || 'UN1T Dublin'
  const logoWidthPx = row?.logo_width_px || 200

  // Phase 3c — edit mode. Hand off rendering to the client overlay
  // which talks to the parent settings page via postMessage. The
  // initial DB state seeds the overlay so it renders something
  // immediately even before the parent posts its first state.
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

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <SiteHeader logoUrl={logoUrl} logoAlt={logoAlt} logoWidthPx={logoWidthPx} />
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
      <SiteFooter />
    </div>
  )
}
