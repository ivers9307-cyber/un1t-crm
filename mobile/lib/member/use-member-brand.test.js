// W1.S5 — SOURCE-level guard for the member-side brand wiring.
//
// useMemberBrand() hands useBrand() the contact's location_id, so the member
// contact context MUST select that column (and the identity spine's boot
// probe, which seeds it, should too): drop it from CONTACT_COLUMNS and every
// member screen quietly falls back to the EMPTY brand — bare "Points", no
// gym name — with no error anywhere. Same precedent as
// contact-context.source.test.js: a React provider in the Expo tree, no
// renderer in the suite, so assert the property at the only level available.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(here, rel), 'utf8')

describe('useMemberBrand wiring (W1.S5)', () => {
  it('the member contact context selects location_id', () => {
    const src = read('contact-context.jsx')
    const m = src.match(/const CONTACT_COLUMNS = '([^']+)'/)
    expect(m, 'CONTACT_COLUMNS literal').toBeTruthy()
    const cols = m[1].split(',').map((c) => c.trim())
    expect(cols).toContain('location_id')
  })

  it('the identity boot probe selects the same columns', () => {
    const ctx = read('contact-context.jsx').match(/const CONTACT_COLUMNS = '([^']+)'/)[1]
    const spine = read('../identity-context.jsx')
    expect(spine).toContain(`.select('${ctx}')`)
  })

  it('the hook reads the brand for the contact location, never a literal', () => {
    const src = read('use-member-brand.js')
    expect(src).toMatch(/useBrand\(contact\?\.location_id/)
    expect(src).not.toMatch(/UN1T/)
  })
})
