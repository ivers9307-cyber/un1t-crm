// AUDIT-13.C — every next.config.js rewrite must land on a real page.
//
// A rewrite whose destination has no page/route file is invisible: the
// visitor gets the same 404 they would have got without the rule, and the
// config still reads as if the old URL works. /races/:id → /events/:id was
// exactly that for over three months — the Calendly-era events/[id] detail
// page existed 2026-04-28 → 05-09 and nothing replaced it, so the rule
// mapped a 404 to a 404 while sitting in a block titled "forever-aliased".
//
// The 2026-06 removal of the E2 aliases records the same failure mode from
// the other direction (rules that could never fire), so this is a class,
// not an incident. This file resolves each destination against src/app the
// way the App Router does — route groups are transparent, a [param]
// directory matches a :param or a literal — and fails if nothing answers.

import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import nextConfig from '../next.config.js'

const APP_DIR = join(import.meta.dirname, '../src/app')
const ENDPOINT_FILES = ['page.js', 'page.jsx', 'page.tsx', 'route.js', 'route.ts']

const isRouteGroup = (name) => name.startsWith('(') && name.endsWith(')')
const isDynamic = (name) => name.startsWith('[')

/**
 * Resolve a rewrite destination to the file that answers it, or null.
 * Mirrors App Router resolution closely enough to catch a missing page:
 * route groups are skipped without consuming a segment, and a [param]
 * directory matches either a :param placeholder or a literal segment
 * (that is how /welcome/stillorgan resolves to welcome/[location]).
 */
function resolveEndpoint(destination) {
  const segments = destination.split('?')[0].split('/').filter(Boolean)
  const found = []

  function walk(dir, i) {
    if (found.length) return
    if (i === segments.length) {
      for (const f of ENDPOINT_FILES) {
        if (existsSync(join(dir, f))) { found.push(join(dir, f)); return }
      }
      return
    }
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const want = segments[i]
    // Exact literal first, then a route group (no segment consumed),
    // then a dynamic directory.
    for (const e of entries) {
      if (e.isDirectory() && e.name === want) walk(join(dir, e.name), i + 1)
    }
    for (const e of entries) {
      if (e.isDirectory() && isRouteGroup(e.name)) walk(join(dir, e.name), i)
    }
    for (const e of entries) {
      if (e.isDirectory() && isDynamic(e.name)) walk(join(dir, e.name), i + 1)
    }
  }

  walk(APP_DIR, 0)
  return found[0] || null
}

const rewrites = await nextConfig.rewrites()

describe('next.config.js rewrites — no rule maps a 404 to a 404', () => {
  for (const rule of rewrites) {
    it(`${rule.source} → ${rule.destination} resolves`, () => {
      expect(
        resolveEndpoint(rule.destination),
        `${rule.destination} has no page/route file — the rewrite is dead config`,
      ).toBeTruthy()
    })
  }

  it('the resolver itself rejects a destination that does not exist', () => {
    expect(resolveEndpoint('/events/:id')).toBeNull()
    expect(resolveEndpoint('/definitely-not-a-page')).toBeNull()
    expect(resolveEndpoint('/events/:id/teams')).toBeTruthy()
  })
})
