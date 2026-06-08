// /welcome/[location] — public per-studio marketing page.
//
// The two-location split (un1tdublin.com): the chooser lives at
// /welcome and links to /welcome/stillorgan + /welcome/hatch-street
// (surfaced publicly as /stillorgan + /hatch-street via next.config
// rewrites). Each studio's content is its own landing_page_settings
// row, resolved here by `public_path` (mig 227) so the public URL is
// decoupled from internal location slugs.
//
// Renders identically to the original single-studio /welcome page —
// same SiteHeader → ordered blocks → SiteFooter via the shared
// BlockRenderers. Editing happens in /settings/landing-page (per
// active location); the live-preview iframe still uses /welcome?edit=1.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'
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
