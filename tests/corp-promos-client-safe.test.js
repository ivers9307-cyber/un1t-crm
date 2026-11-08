// WAYSIN.2 guard: the Glofox plan ids never reach the client bundle.
// src/lib/corp-promos.js is imported by client components directly and through
// src/lib/landing-page-blocks.js, so neither may carry a plan id or a plan-id
// field. The ids live in corp_promos (mig 816) and in SEED_GLOFOX_PLANS in the
// server-only src/lib/corp-promo-glofox-plans.js. A text floor, not a proof.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SEED_GLOFOX_PLANS } from '../src/lib/corp-promo-glofox-plans.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLIENT_REACHABLE = ['src/lib/corp-promos.js', 'src/lib/landing-page-blocks.js']
// Client components that legitimately name the plan-id FIELDS (the owner's
// promo editor shows and sends them; the landing picker reads promo rows) but
// must never carry an id itself: the id-string check only.
const CLIENT_COMPONENTS = ['src/components/settings/CorpPromosCard.jsx', 'src/components/landing-pages/studio-offer-fields.jsx']
const ID_STRINGS = Object.values(SEED_GLOFOX_PLANS).flatMap((p) => [p.membershipId, p.planCode, p.planName])

describe('corp promo modules a client imports carry no Glofox plan ids', () => {
  it('the seed constant still names the ids this guard searches for', () => {
    expect(ID_STRINGS).toEqual(['6aec95d590a936f18c065d9f', '1793889679121', 'New Start Free Trial'])
  })

  for (const file of CLIENT_REACHABLE) {
    it(`${file}: no plan id string and no plan-id field`, () => {
      const src = readFileSync(path.join(ROOT, file), 'utf8')
      for (const id of ID_STRINGS) expect(src, `${file} contains ${id}`).not.toContain(id)
      expect(src).not.toMatch(/glofox_membership_id|membershipId/)
    })
  }

  for (const file of CLIENT_COMPONENTS) {
    it(`${file}: no plan id string`, () => {
      const src = readFileSync(path.join(ROOT, file), 'utf8')
      for (const id of ID_STRINGS) expect(src, `${file} contains ${id}`).not.toContain(id)
    })
  }
})
