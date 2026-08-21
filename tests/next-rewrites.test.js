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
// not an incident. Resolution is tests/helpers/app-router-resolve.js — the
// same rules src/lib/command-palette.test.js uses to prove every launcher
// href lands somewhere, extended to route.js handlers for the /api rules.

import { describe, it, expect } from 'vitest'
import { endpointFileFor } from './helpers/app-router-resolve.js'
import nextConfig from '../next.config.js'

const rewrites = await nextConfig.rewrites()

describe('next.config.js rewrites — no rule maps a 404 to a 404', () => {
  for (const rule of rewrites) {
    it(`${rule.source} → ${rule.destination} resolves`, () => {
      expect(
        endpointFileFor(rule.destination),
        `${rule.destination} has no page/route file — the rewrite is dead config`,
      ).toBeTruthy()
    })
  }

  it('the resolver itself rejects a destination that does not exist', () => {
    expect(endpointFileFor('/events/:id')).toBeNull()
    expect(endpointFileFor('/definitely-not-a-page')).toBeNull()
    expect(endpointFileFor('/events/:id/teams')).toBeTruthy()
  })
})
