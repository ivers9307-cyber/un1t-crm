// TPLCLONE.1 — structural guards for the shift-template copy.
//
// 1. Every column of shift_templates (replayed from supabase/migrations, the
//    same replay check:select-columns gates on) is either COPIED or MANAGED by
//    the copy. A new column fails here until someone decides which: that is
//    how SHIFTTYPE.1's `kind` becomes a one-line change and never a column a
//    copy drops in silence.
// 2. The clone route passes check:location-scoping, and more strictly than the
//    gate asks: EVERY shift_templates chain carries its studio in the chain
//    itself. The gate accepts evidence anywhere in the file, and this route has
//    assertLocationAccess, so a chain that lost .eq('location_id', …) would
//    still pass it.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import {
  collectLocationTables,
  classifyRoute,
  extractQueryChains,
  chainHasTenantEvidence,
} from '../scripts/check-location-scoping.mjs'
import { TEMPLATE_CLONE_COLUMNS, TEMPLATE_CLONE_MANAGED_COLUMNS } from '../src/lib/shift-template-clone.js'

describe('TPLCLONE.1 — every shift_templates column is classified for the copy', () => {
  const { schema } = collectSchema('supabase/migrations')
  const columns = [...(schema.get('shift_templates') || [])].sort()

  it('the replay found the table', () => {
    expect(columns).toContain('name')
    expect(columns).toContain('location_id')
  })

  it('each column is copied or managed, never both, never neither', () => {
    const copied = new Set(TEMPLATE_CLONE_COLUMNS)
    const managed = new Set(TEMPLATE_CLONE_MANAGED_COLUMNS)
    expect(columns.filter((c) => copied.has(c) && managed.has(c))).toEqual([])
    // A new column lands here until it goes on TEMPLATE_CLONE_COLUMNS (the copy
    // carries it) or TEMPLATE_CLONE_MANAGED_COLUMNS (the copy sets it itself).
    expect(columns.filter((c) => !copied.has(c) && !managed.has(c))).toEqual([])
  })

  it('names no column the table does not have', () => {
    const real = new Set(columns)
    expect([...TEMPLATE_CLONE_COLUMNS, ...TEMPLATE_CLONE_MANAGED_COLUMNS].filter((c) => !real.has(c))).toEqual([])
  })
})

describe('TPLCLONE.1 — the clone route is scoped to a studio on every chain', () => {
  const rel = 'src/app/api/schedule/templates/clone/route.js'
  const src = fs.readFileSync(rel, 'utf8')
  const tables = collectLocationTables('supabase/migrations')

  it('check:location-scoping finds nothing unscoped and needs no exemption', () => {
    expect(classifyRoute(rel, src, tables)).toEqual({ findings: [] })
  })

  it('the source read, the target read and the insert each name the studio in the chain', () => {
    const chains = extractQueryChains(src, 'shift_templates')
    expect(chains).toHaveLength(3)
    expect(chains.filter((c) => !chainHasTenantEvidence(c))).toEqual([])
  })
})
