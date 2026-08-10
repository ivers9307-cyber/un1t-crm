import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// COMMSLAYOUT.5 — light-theme contrast on the Communications surfaces.
//
// The palette is a LIGHT theme with inverted token names, so an accent colour
// at the -300/-400/-500 ramp is washed out on a `bg-un1t-surface` card. CLAUDE.md
// settles the recipe for status chips (`bg-<c>-500/10 text-<c>-700`) and
// `check:guardrails` (`no-low-contrast-chip`) enforces exactly that pairing —
// but plain accent TEXT with no chip background is invisible to that rule, and
// the hub's stat figures ("Open rate", the SMS tiles) and the templates list's
// channel icons were slipping through at -400/-500.
//
// These are ALL light surfaces: none of the paths below is in the dark-surface
// exclusion list in eslint.guardrails.config.mjs (tv / present / event /
// host), which is the repo's own record of which surfaces render on black.

const ROOTS = [
  'src/app/communications',
  // The templates surfaces reachable from the Templates tab. /email/templates
  // and /whatsapp/templates are redirect stubs; the editors are the real pages.
  'src/app/email/templates',
  'src/app/whatsapp/templates',
  // Components that only ever render inside those pages.
  'src/components/communications',
]

const FILES = [
  'src/components/WhatsappTemplatesList.jsx',   // the WhatsApp half of /communications/templates
  'src/components/SegmentsGrid.jsx',            // /communications/segments
  'src/components/SavedSegmentsList.jsx',       // /communications/segments
]

// A Tailwind text colour at a ramp too low to read on a light card. Deliberately
// only `text-` (backgrounds at -500/10 are the correct chip recipe) and only the
// named palettes (un1t-* tokens carry their own intent).
const LOW_RAMP_TEXT =
  /(?:^|[\s"'`:])(?:hover:|focus:|group-hover:|md:|lg:|sm:)?text-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:300|400|500)\b/g

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(js|jsx)$/.test(e) && !/\.test\.(js|jsx)$/.test(e)) out.push(p)
  }
  return out
}

describe('Communications surfaces use the -700 ramp on light cards', () => {
  const files = [
    ...ROOTS.flatMap((r) => walk(join(process.cwd(), r))),
    ...FILES.map((f) => join(process.cwd(), f)),
  ]

  it('finds the pages to check (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    const rel = file.slice(process.cwd().length + 1)
    it(`${rel} has no -300/-400/-500 accent text`, () => {
      const hits = (readFileSync(file, 'utf8').match(LOW_RAMP_TEXT) || []).map((h) => h.trim())
      expect(hits, `${rel}: use the -700 ramp on light surfaces`).toEqual([])
    })
  }
})
