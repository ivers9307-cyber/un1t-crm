// PIPELINES.2 — the registry contract. A board module that forgets
// requiredFields is the PIPELINE-FLAP defect class in a new costume: the
// orchestrator would select fewer columns than classify() reads, compute on
// nulls, and drag every webhook-placed deal back overnight.

import { describe, it, expect } from 'vitest'
import { getBoardModule, BOARD_MODULES } from './index.js'

describe('board registry', () => {
  it('exposes the acquisition module by name', () => {
    expect(getBoardModule('acquisition')).toBeTruthy()
  })

  it('returns null for an unknown module rather than throwing', () => {
    expect(getBoardModule('nope')).toBeNull()
  })

  it('every registered module satisfies the contract', () => {
    for (const [name, mod] of Object.entries(BOARD_MODULES)) {
      expect(Array.isArray(mod.stages), `${name}.stages`).toBe(true)
      expect(mod.stages.length, `${name}.stages non-empty`).toBeGreaterThan(0)
      expect(Array.isArray(mod.requiredFields), `${name}.requiredFields`).toBe(true)
      expect(mod.requiredFields.length, `${name}.requiredFields non-empty`).toBeGreaterThan(0)
      expect(typeof mod.classify, `${name}.classify`).toBe('function')
      for (const stage of mod.stages) {
        expect(typeof stage.slug, `${name} stage slug`).toBe('string')
        expect(typeof stage.name, `${name} stage name`).toBe('string')
      }
    }
  })

  it('acquisition declares every field its classifier reads', () => {
    const { requiredFields } = getBoardModule('acquisition')
    for (const f of [
      'glofox_membership_status', 'recent_bookings', 'converted_at',
      'pack_customer_at', 'pipeline_dismissed_at', 'gympass_member_id',
      'last_lead_source_at', 'trial_credits_remaining', 'joined_at',
      'last_attended_at',
    ]) {
      expect(requiredFields, `missing ${f}`).toContain(f)
    }
  })
})
