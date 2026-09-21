// TABTITLE.1 — the staff tab names the ACTIVE studio.
//
// Two halves. The resolver (what staffTabMetadata returns for a session), and
// the COMPOSITION: the rendered <title> is not what this module returns, it is
// what Next makes of it together with the root layout and the page.
//
// The composition half drives the INSTALLED Next's own accumulateMetadata
// (next/dist/lib/metadata/resolve-metadata), the function the server renders
// <title> from, with one item per route-tree node. Nothing of Next's rules is
// re-implemented here, so an upgrade that changes how templates reach child
// segments, or how a nested default meets a parent template, fails in this
// file rather than in a browser tab.
//
// What is NOT pinned: that the route tree really has the nodes each case
// spells out (one per directory, route groups included, plus the page). That
// is resolveMetadataItems' job, it needs a compiled loader tree, and it was
// read in source, not executed. `next build` + a browser is the check for it.

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

// resolve-metadata.js does `require('server-only')`, a bare specifier that only
// Next's bundler can resolve (it aliases it to this same compiled no-op on the
// server). Point Node at that module for the one require, then put it back.
const require = createRequire(import.meta.url)
const Module = require('node:module')
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  return resolveFilename.call(this, request === 'server-only' ? 'next/dist/compiled/server-only/empty' : request, ...rest)
}
let accumulateMetadata
try {
  ;({ accumulateMetadata } = require('next/dist/lib/metadata/resolve-metadata'))
} finally {
  Module._resolveFilename = resolveFilename
}

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

  // Swallowed, but never silently: a sustained metadata-only failure renders
  // every page fine and shows up nowhere else.
  it('a title is never worth a 500, and the failure is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom = new Error('auth down')
      getCurrentUser.mockRejectedValue(boom)
      await expect(staffTabMetadata()).resolves.toEqual({})
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0][0]).toMatch(/^\[staff-tab-title\]/)
      expect(logged.mock.calls[0][1]).toBe(boom)
    } finally {
      logged.mockRestore()
    }
  })

  // Swallowing Next's own control-flow throw could prerender a route with {}
  // baked in. unstable_rethrow is the documented way to let those through.
  // Not ours, so not logged either.
  it('does NOT swallow (or log) an error Next threw on purpose', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bailout = Object.assign(new Error('Dynamic server usage: cookies'), { digest: 'DYNAMIC_SERVER_USAGE' })
      getCurrentUser.mockRejectedValue(bailout)
      await expect(staffTabMetadata()).rejects.toBe(bailout)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
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

// One item per route-tree node, root layout first, page last; null where a
// node exports no metadata. Items are [metadataExport, staticFilesMetadata].
async function renderedTitle(items) {
  const resolved = await accumulateMetadata(
    '/probe',
    items.map((meta) => [meta, null]),
    '/probe',
    { trailingSlash: false, isStaticMetadataRouteFile: false },
  )
  return resolved.title?.absolute ?? ''
}

describe('staffTabMetadata — what the tab actually reads (installed Next accumulateMetadata)', () => {
  const ROOT = { title: 'UN1T Hatch Street' } // resolveDefaultSiteName: first row by location_id
  const STAFF = staffTabMetadataFor('UN1T Stillorgan')

  it('a staff page with no title of its own reads the active studio', async () => {
    // '' -> (sales) -> contacts -> __PAGE__
    expect(await renderedTitle([ROOT, STAFF, null, null])).toBe('UN1T Stillorgan')
    // '' -> approvals (new pass-through layout) -> __PAGE__
    expect(await renderedTitle([ROOT, STAFF, null])).toBe('UN1T Stillorgan')
  })

  it('/schedule still reads exactly what ROSTERLOOK.1 shipped', async () => {
    // '' -> (team) -> schedule -> __PAGE__ { title: 'Schedule' }
    expect(await renderedTitle([ROOT, STAFF, null, { title: 'Schedule' }])).toBe('Schedule · UN1T Stillorgan')
    // ...and with no active studio, the bare page name, as before.
    expect(await renderedTitle([ROOT, {}, null, { title: 'Schedule' }])).toBe('Schedule')
  })

  it('no active studio leaves the root title in place', async () => {
    expect(await renderedTitle([ROOT, {}, null, null])).toBe('UN1T Hatch Street')
  })

  it('a layout nested under the staff layout that adds nothing changes nothing', async () => {
    // '' -> communications -> (hub) -> inbox -> __PAGE__
    expect(await renderedTitle([ROOT, STAFF, null, null, null])).toBe('UN1T Stillorgan')
  })

  // The two traps the coverage test exists to keep out of src/app. Pinned here
  // so its rules are demonstrably Next's behaviour, not folklore.
  it('TRAP: two staff layouts on one route double the studio', async () => {
    expect(await renderedTitle([ROOT, STAFF, STAFF, null])).toBe('UN1T Stillorgan · UN1T Stillorgan')
  })

  it('TRAP: a page in the SAME segment as the staff layout is not templated', async () => {
    expect(await renderedTitle([ROOT, STAFF, { title: 'Approvals' }])).toBe('Approvals')
  })
})
