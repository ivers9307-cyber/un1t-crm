// FILTER-A.1 — preset audiences.
//
// A preset is a SHORTCUT, never a black box: clicking one writes real,
// editable filter rows into the builder. That makes the definitions below
// load-bearing, so they are pinned here field-by-field. The live counts they
// produce (Stillorgan, through the real send gates) are recorded in
// phase-A-builder-spec.md; if a definition drifts from that table the send no
// longer delivers the audience the chip promised.

import { describe, it, expect } from 'vitest'
import { AUDIENCE_PRESETS, presetFilter } from './audience-presets.js'
import { AUDIENCE_FIELDS, validateAudienceFilter } from './audience-filter.js'

describe('AUDIENCE_PRESETS — the verified definitions', () => {
  it('exposes exactly the seven presets the spec verified, in order', () => {
    expect(AUDIENCE_PRESETS.map(p => p.id)).toEqual([
      'everyone_emailable',
      'except_monthly_members',
      'members',
      'dormant',
      'pack_members',
      'in_arrears',
      'sent_never_opened',
    ])
  })

  it('encodes each preset as the exact rows the spec measured', () => {
    const byId = Object.fromEntries(AUDIENCE_PRESETS.map(p => [p.id, p.filters]))
    // The consent gates do the work — no rows at all.
    expect(byId.everyone_emailable).toEqual([])
    // NULL-inclusive `is not` (FILTER-P1.2) is what makes this 3,195 and not
    // 3,050 — the 145 unsynced contacts a hand-built version silently drops.
    expect(byId.except_monthly_members).toEqual([
      { field: 'glofox_membership_type', op: 'neq', value: 'time' },
    ])
    expect(byId.members).toEqual([
      { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
    ])
    expect(byId.dormant).toEqual([
      { field: 'pipeline_stage_slug', op: 'eq', value: 'dormant' },
    ])
    expect(byId.pack_members).toEqual([
      { field: 'pipeline_stage_slug', op: 'eq', value: 'pack_member' },
    ])
    expect(byId.in_arrears).toEqual([
      { field: 'glofox_membership_state', op: 'eq', value: 'locked' },
    ])
    expect(byId.sent_never_opened).toEqual([
      { field: 'total_emails_sent', op: 'gt', value: '0' },
      { field: 'total_emails_opened', op: 'eq', value: '0' },
    ])
  })

  it('every preset row is on the server allowlist for both field and op', () => {
    for (const preset of AUDIENCE_PRESETS) {
      for (const row of preset.filters) {
        const cfg = AUDIENCE_FIELDS[row.field]
        expect(cfg, `${preset.id}: unknown field ${row.field}`).toBeTruthy()
        expect(cfg.ops, `${preset.id}: ${row.field} disallows ${row.op}`).toContain(row.op)
      }
    }
  })

  it('every preset survives save-time validation (no preset can be unsaveable)', () => {
    for (const preset of AUDIENCE_PRESETS) {
      expect(() => validateAudienceFilter(presetFilter(preset)), preset.id).not.toThrow()
    }
  })

  it('carries a human label and a plain-English description for every preset', () => {
    for (const preset of AUDIENCE_PRESETS) {
      expect(preset.label, preset.id).toBeTruthy()
      expect(preset.description, preset.id).toBeTruthy()
    }
  })

  it('NEVER carries a hard-coded count — a chip must not promise a number the send has to honour', () => {
    for (const preset of AUDIENCE_PRESETS) {
      expect(preset).not.toHaveProperty('count')
      expect(JSON.stringify(preset)).not.toMatch(/\b(3360|3,360|3195|3,195|1233|1,233)\b/)
    }
  })
})

describe('presetFilter', () => {
  it('always builds an AND filter (every multi-row preset is a conjunction)', () => {
    const p = AUDIENCE_PRESETS.find(x => x.id === 'sent_never_opened')
    expect(presetFilter(p)).toEqual({
      logic: 'and',
      filters: [
        { field: 'total_emails_sent', op: 'gt', value: '0' },
        { field: 'total_emails_opened', op: 'eq', value: '0' },
      ],
    })
  })

  it('returns fresh row objects so editing a preset cannot mutate the registry', () => {
    const p = AUDIENCE_PRESETS.find(x => x.id === 'members')
    const built = presetFilter(p)
    built.filters[0].value = 'edited'
    expect(AUDIENCE_PRESETS.find(x => x.id === 'members').filters[0].value).toBe('member')
  })

  it('gives the empty preset an empty AND filter, not a null', () => {
    const p = AUDIENCE_PRESETS.find(x => x.id === 'everyone_emailable')
    expect(presetFilter(p)).toEqual({ logic: 'and', filters: [] })
  })
})
