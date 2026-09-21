// TABTITLE.1 — the staff tab names the ACTIVE studio.
//
// Two halves. The resolver (what staffTabMetadata returns for a session), and
// the COMPOSITION: the rendered <title> is not what this module returns, it is
// what Next makes of it together with the root layout and the page. That half
// runs the installed Next's own title resolver, replaying the same loop as
// accumulateMetadata (lib/metadata/resolve-metadata.js), so a Next upgrade
// that changes the template rules fails here instead of in a browser tab.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

vi.mock('./auth', () => ({ getCurrentUser: vi.fn() }))
// Only the control-flow errors Next itself throws carry a NEXT_/DYNAMIC digest.
vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn((err) => {
    if (typeof err?.digest === 'string') throw err
  }),
}))

import { getCurrentUser } from './auth'
import {
  staffTabMetadata,
  staffTabMetadataFor,
  STAFF_TITLE_SEPARATOR,
} from './staff-tab-title.js'

const require = createRequire(import.meta.url)
const { resolveTitle } = require('next/dist/lib/metadata/resolvers/resolve-title')

beforeEach(() => vi.clearAllMocks())

describe('staffTabMetadata — resolver', () => {
  it('names the ACTIVE studio, with a template for page names', async () => {
    getCurrentUser.mockResolvedValue({ activeLocation: { id: 'l1', name: 'UN1T Stillorgan' } })
    expect(await staffTabMetadata()).toEqual({
      title: { default: 'UN1T Stillorgan', template: '%s · UN1T Stillorgan' },
    })
  })

  it('a master or org admin with an active studio gets that studio', async () => {
    getCurrentUser.mockResolvedValue({
      isMaster: true, profileRole: 'master', activeLocation: { id: 'l2', name: 'UN1T Hatch Street' },
    })
    expect((await staffTabMetadata()).title.default).toBe('UN1T Hatch Street')
  })

  it('contributes NOTHING without a session or a named studio (the root title stands)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect(await staffTabMetadata()).toEqual({})
    getCurrentUser.mockResolvedValue({ activeLocation: null })
    expect(await staffTabMetadata()).toEqual({})
    getCurrentUser.mockResolvedValue({ activeLocation: { id: 'l1' } })
    expect(await staffTabMetadata()).toEqual({})
    getCurrentUser.mockResolvedValue({ activeLocation: { id: 'l1', name: '   ' } })
    expect(await staffTabMetadata()).toEqual({})
  })

  it('a title is never worth a 500', async () => {
    getCurrentUser.mockRejectedValue(new Error('auth down'))
    await expect(staffTabMetadata()).resolves.toEqual({})
  })

  // Swallowing Next's own control-flow throw could prerender a route with {}
  // baked in. unstable_rethrow is the documented way to let those through.
  it('does NOT swallow an error Next threw on purpose', async () => {
    const bailout = Object.assign(new Error('Dynamic server usage: cookies'), { digest: 'DYNAMIC_SERVER_USAGE' })
    getCurrentUser.mockRejectedValue(bailout)
    await expect(staffTabMetadata()).rejects.toBe(bailout)
  })

  it('trims the name and uses no em-dash', () => {
    expect(staffTabMetadataFor('  UN1T Stillorgan ')).toEqual({
      title: { default: 'UN1T Stillorgan', template: '%s · UN1T Stillorgan' },
    })
    expect(STAFF_TITLE_SEPARATOR).toBe(' · ')
    expect(JSON.stringify(staffTabMetadataFor('X'))).not.toMatch(/—|–/)
  })

  it('a studio NAMED with "%s" gets no template (Next would splice the page title into it)', () => {
    expect(staffTabMetadataFor('Gym %s')).toEqual({ title: 'Gym %s' })
  })
})

// Replays accumulateMetadata's title handling: one item per TREE NODE (root
// layout ... page), null where a node exports nothing, and the template a
// node defines is only stashed for nodes before the last two (the leaf layout
// and its page share a segment).
function renderedTitle(items) {
  let title = null
  let stashedTemplate = null
  items.forEach((meta, i) => {
    if (meta && 'title' in meta) title = resolveTitle(meta.title, stashedTemplate)
    if (i < items.length - 2) stashedTemplate = title?.template || null
  })
  return title?.absolute ?? ''
}

describe('staffTabMetadata — what the tab actually reads (installed Next resolver)', () => {
  const ROOT = { title: 'UN1T Hatch Street' } // resolveDefaultSiteName: first row by location_id
  const STAFF = staffTabMetadataFor('UN1T Stillorgan')

  it('a staff page with no title of its own reads the active studio', () => {
    // '' -> (sales) -> contacts -> __PAGE__
    expect(renderedTitle([ROOT, STAFF, null, null])).toBe('UN1T Stillorgan')
    // '' -> approvals (new pass-through layout) -> __PAGE__
    expect(renderedTitle([ROOT, STAFF, null])).toBe('UN1T Stillorgan')
  })

  it('/schedule still reads exactly what ROSTERLOOK.1 shipped', () => {
    // '' -> (team) -> schedule -> __PAGE__ { title: 'Schedule' }
    expect(renderedTitle([ROOT, STAFF, null, { title: 'Schedule' }])).toBe('Schedule · UN1T Stillorgan')
    // ...and with no active studio, the bare page name, as before.
    expect(renderedTitle([ROOT, {}, null, { title: 'Schedule' }])).toBe('Schedule')
  })

  it('no active studio leaves the root title in place', () => {
    expect(renderedTitle([ROOT, {}, null, null])).toBe('UN1T Hatch Street')
  })

  it('a layout nested under the staff layout that adds nothing changes nothing', () => {
    // '' -> communications -> (hub) -> inbox -> __PAGE__
    expect(renderedTitle([ROOT, STAFF, null, null, null])).toBe('UN1T Stillorgan')
  })

  // The two traps the coverage test exists to keep out of src/app. Pinned here
  // so its rules are demonstrably Next's behaviour, not folklore.
  it('TRAP: two staff layouts on one route double the studio', () => {
    expect(renderedTitle([ROOT, STAFF, STAFF, null])).toBe('UN1T Stillorgan · UN1T Stillorgan')
  })

  it('TRAP: a page in the SAME segment as the staff layout is not templated', () => {
    expect(renderedTitle([ROOT, STAFF, { title: 'Approvals' }])).toBe('Approvals')
  })
})
