// /welcome — public marketing entry point.
//
// Two-location split (un1tdublin.com): this page is now the SPLIT
// CHOOSER — two full-screen panels, click left → Stillorgan, right →
// Hatch Street. Each studio's full marketing page lives at
// /welcome/[location] (public_path), surfaced as /stillorgan and
// /hatch-street via next.config rewrites.
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

// Load the studios for the chooser tiles. Each tile needs a path, a
// display name, and a cover image (chooser_image_url → hero image →
// null for a gradient placeholder). Ordered so Stillorgan is the
// left/top tile and Hatch Street the right/bottom.
const TILE_ORDER = ['stillorgan', 'hatch-street']
async function loadStudios() {
  try {
    const db = createServerClient()
    const { data } = await db
      .from('landing_page_settings')
      .select('public_path, chooser_image_url, blocks, locations:location_id ( name )')
      .not('public_path', 'is', null)
    const rows = data || []
    const byPath = new Map(rows.map((r) => [r.public_path, r]))
    return TILE_ORDER
      .map((path) => byPath.get(path))
      .filter(Boolean)
      .map((r) => {
        const hero = blocksOrDefault(r.blocks).find((b) => b.type === 'hero')
        return {
          path: r.public_path,
          name: r.locations?.name || r.public_path,
          cover: r.chooser_image_url || hero?.image_url || null,
        }
      })
  } catch {
    return []
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

  const studios = await loadStudios()

  return (
    <main className="min-h-screen bg-black text-white antialiased flex flex-col md:flex-row">
      {studios.map((s) => (
        <Link
          key={s.path}
          href={`/welcome/${s.path}`}
          className="group relative flex-1 min-h-[50vh] md:min-h-screen overflow-hidden flex items-center justify-center border-b border-white/10 md:border-b-0 md:border-r last:border-0"
        >
          {/* Cover image (operator-set or hero fallback). When absent,
              the gradient placeholder below shows through. Swap to real
              cover images later via chooser_image_url. */}
          {s.cover ? (
            <div
              className="absolute inset-0 bg-cover bg-center transition-transform duration-700 ease-out group-hover:scale-105"
              style={{ backgroundImage: `url(${s.cover})` }}
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-neutral-800 via-neutral-900 to-black transition-transform duration-700 ease-out group-hover:scale-105" />
          )}
          {/* Dark scrim — deepens on the non-hovered side so the
              hovered studio reads as "selected". */}
          <div className="absolute inset-0 bg-black/50 transition-colors duration-500 group-hover:bg-black/30" />
          <div className="relative z-10 text-center px-6">
            <div className="text-[11px] uppercase tracking-[0.3em] text-white/60 mb-3">UN1T Dublin</div>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">{s.name}</h2>
            <div className="mt-5 inline-flex items-center gap-2 text-sm uppercase tracking-wider text-white/80 group-hover:text-white transition-colors">
              Enter
              <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
            </div>
          </div>
        </Link>
      ))}

      {studios.length === 0 && (
        <div className="flex-1 min-h-screen flex items-center justify-center text-white/60 text-sm">
          No studios configured.
        </div>
      )}
    </main>
  )
}
