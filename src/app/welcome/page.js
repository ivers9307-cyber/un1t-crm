// /welcome — public marketing entry point.
//
// Two-location split (un1tdublin.com): this page is now the SPLIT
// CHOOSER — two full-screen panels, click left → Stillorgan, right →
// Hatch Street. Each studio's full marketing page lives at
// /welcome/[location] (public_path), surfaced as /stillorgan and
// /hatch-street via next.config rewrites.
//
// The chooser is operator-editable from /settings/landing-page
// (?page=chooser → ChooserEditorForm → PUT /api/chooser-settings):
//   - page-level headline + intro (chooser_settings, singleton row)
//   - per-tile label / CTA text / cover image / order
//     (landing_page_settings.chooser_* + chooser_settings.tile_order)
// This render reads ALL of those so the editor round-trips end-to-end.
//
// Edit mode (?edit=1) is UNCHANGED: it still mounts EditModeOverlay
// for the live-preview iframe inside /settings/landing-page, which
// drives the overlay via postMessage. The editor branch runs BEFORE
// the chooser render, so the editor keeps working exactly as before.

import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'

export const dynamic = 'force-dynamic'

// ─── Temporarily disabled tiles ────────────────────────────────────
// public_path values listed here render as a dimmed, NON-clickable
// "coming soon" panel (no link, no CTA button). The studio's page at
// /welcome/<path> still exists and is untouched — only the chooser
// tile's link is suppressed. To DISABLE a studio, add its public_path
// here; to RE-ENABLE, remove it. (Set, not a DB flag, so it's a
// one-line change with no migration.)
//
// 2026-06-08: Hatch Street UNLOCKED — the tile is now live + clickable
// ahead of the September opening (founding-members drive). Set is empty
// again; nothing is currently suppressed.
const DISABLED_TILE_PATHS = new Set([])

// Default left→right order when the operator hasn't set tile_order.
const TILE_ORDER = ['stillorgan', 'hatch-street']

// Edit-mode seed (unchanged behaviour): most-recently-edited row.
// The overlay is postMessage-driven so the seed is just the initial
// paint; which row seeds it doesn't affect the editing experience.
async function loadEditSeed() {
  try {
    const db = createServerClient()
    const { data } = await db
      .from('landing_page_settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data || null
  } catch {
    return null
  }
}

// Load the whole front page: the singleton chooser row (headline /
// intro / tile_order) plus every studio tile (label, CTA, cover,
// hero-image fallback). Tiles are returned in the operator's saved
// order, falling back to TILE_ORDER.
async function loadFrontPage() {
  try {
    const db = createServerClient()
    const [chooserRes, tilesRes] = await Promise.all([
      db.from('chooser_settings')
        .select('headline, intro, tile_order')
        .eq('id', 'default')
        .maybeSingle(),
      db.from('landing_page_settings')
        .select('public_path, chooser_label, chooser_cta_text, chooser_image_url, blocks, locations:location_id ( name )')
        .not('public_path', 'is', null),
    ])

    const chooser = chooserRes.data || {}
    const order = Array.isArray(chooser.tile_order) && chooser.tile_order.length
      ? chooser.tile_order
      : TILE_ORDER

    const byPath = new Map((tilesRes.data || []).map((r) => [r.public_path, r]))
    const tiles = order
      .map((path) => byPath.get(path))
      .filter(Boolean)
      .map((r) => {
        const hero = blocksOrDefault(r.blocks).find((b) => b.type === 'hero')
        return {
          path: r.public_path,
          // Operator label wins over the location name; fall back to path.
          name: (r.chooser_label && r.chooser_label.trim())
            || r.locations?.name
            || r.public_path,
          cta: (r.chooser_cta_text && r.chooser_cta_text.trim()) || 'Enter',
          cover: r.chooser_image_url || hero?.image_url || null,
          disabled: DISABLED_TILE_PATHS.has(r.public_path),
        }
      })

    return {
      headline: (chooser.headline && chooser.headline.trim()) || null,
      intro: (chooser.intro && chooser.intro.trim()) || null,
      tiles,
    }
  } catch {
    return { headline: null, intro: null, tiles: [] }
  }
}

export const metadata = {
  title: 'UN1T Dublin — Choose your studio',
  description: 'Two Dublin studios. Coach-led strength + conditioning, built for racing. Choose Stillorgan or Hatch Street.',
  openGraph: {
    title: 'UN1T Dublin — Choose your studio',
    description: 'Two Dublin studios — Stillorgan & Hatch Street. Coach-led strength + conditioning, built for racing.',
    siteName: 'UN1T Dublin',
    type: 'website',
  },
}

// Shared inner content for a tile (cover image + scrim + centre text).
// Rendered inside either a <Link> (active) or a <div> (disabled).
function TileBody({ s }) {
  return (
    <>
      {/* Cover image (operator-set or hero fallback). When absent,
          the gradient placeholder below shows through. */}
      {s.cover ? (
        <div
          className={`absolute inset-0 bg-cover bg-center transition-transform duration-700 ease-out ${s.disabled ? '' : 'group-hover:scale-105'}`}
          style={{ backgroundImage: `url(${s.cover})` }}
        />
      ) : (
        <div className={`absolute inset-0 bg-gradient-to-br from-neutral-800 via-neutral-900 to-black transition-transform duration-700 ease-out ${s.disabled ? '' : 'group-hover:scale-105'}`} />
      )}
      {/* Dark scrim — deeper on a disabled tile so it reads as inactive;
          on active tiles it lightens on hover to read as "selected". */}
      <div className={`absolute inset-0 transition-colors duration-500 ${s.disabled ? 'bg-black/70' : 'bg-black/50 group-hover:bg-black/30'}`} />
      <div className="relative z-10 text-center px-6">
        <div className="text-[11px] uppercase tracking-[0.3em] text-white/60 mb-3">UN1T Dublin</div>
        <h2 className={`text-3xl md:text-5xl font-extrabold tracking-tight ${s.disabled ? 'text-white/70' : ''}`}>{s.name}</h2>
        {/* CTA only on active tiles. Disabled tiles show the label alone. */}
        {!s.disabled && (
          <div className="mt-5 inline-flex items-center gap-2 text-sm uppercase tracking-wider text-white/80 group-hover:text-white transition-colors">
            {s.cta}
            <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
          </div>
        )}
      </div>
    </>
  )
}

export default async function WelcomePage(props) {
  const searchParams = await props.searchParams

  // Edit-mode preview iframe (unchanged).
  if (searchParams?.edit === '1') {
    const row = await loadEditSeed()
    const blocks = blocksOrDefault(row?.blocks)
    return (
      <EditModeOverlay
        initialBlocks={blocks}
        initialLogoUrl={row?.logo_url || null}
        initialLogoAlt={row?.logo_alt || 'UN1T Dublin'}
        initialLogoWidthPx={row?.logo_width_px || 200}
      />
    )
  }

  const { headline, intro, tiles } = await loadFrontPage()

  const tileWrapClasses = 'group relative flex-1 min-h-[50vh] md:min-h-screen overflow-hidden flex items-center justify-center border-b border-white/10 md:border-b-0 md:border-r last:border-0'

  return (
    <main className="relative min-h-screen bg-black text-white antialiased flex flex-col md:flex-row">
      {/* Operator headline / intro, centred across the split. Overlay is
          click-through (pointer-events-none) so it never blocks a tile. */}
      {(headline || intro) && (
        <div className="pointer-events-none absolute top-0 inset-x-0 z-20 pt-8 md:pt-10 px-6 text-center">
          {headline && (
            <h1 className="text-xl md:text-3xl font-extrabold tracking-tight drop-shadow">{headline}</h1>
          )}
          {intro && (
            <p className="mt-2 text-sm md:text-base text-white/80 drop-shadow">{intro}</p>
          )}
        </div>
      )}

      {tiles.map((s) =>
        s.disabled ? (
          <div
            key={s.path}
            aria-disabled="true"
            className={`${tileWrapClasses} cursor-not-allowed select-none`}
          >
            <TileBody s={s} />
          </div>
        ) : (
          <Link key={s.path} href={`/welcome/${s.path}`} className={tileWrapClasses}>
            <TileBody s={s} />
          </Link>
        )
      )}

      {tiles.length === 0 && (
        <div className="flex-1 min-h-screen flex items-center justify-center text-white/60 text-sm">
          No studios configured.
        </div>
      )}
    </main>
  )
}
