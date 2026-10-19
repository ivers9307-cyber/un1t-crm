// PIPELINES.2 — the registry contract. A board module that forgets
// requiredFields is the PIPELINE-FLAP defect class in a new costume: the
// orchestrator would select fewer columns than classify() reads, compute on
// nulls, and drag every webhook-placed deal back overnight.

import { describe, it, expect } from 'vitest'
import { getBoardModule, BOARD_MODULES } from './index.js'
import { classify as un1tClassify } from './acquisition-un1t.js'
import { classify as glofoxClassify } from './acquisition.js'

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

  it('registers acquisition_un1t with inputSource un1t_online', () => {
    const mod = getBoardModule('acquisition_un1t')
    expect(mod).toBeTruthy()
    expect(mod.inputSource).toBe('un1t_online')
  })

  it('acquisition_un1t shares acquisition stages by reference; classify is its own wrapper (TRIALDONE.2)', () => {
    const acq = getBoardModule('acquisition')
    const un1t = getBoardModule('acquisition_un1t')
    expect(un1t.stages).toBe(acq.stages)
    expect(un1t.classify).toBe(un1tClassify)
    expect(un1t.classify).not.toBe(acq.classify)
  })

  it('acquisition_un1t requires only id, name, email, location_id', () => {
    const { requiredFields } = getBoardModule('acquisition_un1t')
    expect([...requiredFields].sort()).toEqual(['email', 'id', 'location_id', 'name'])
  })

  it('acquisition declares no inputSource', () => {
    expect(getBoardModule('acquisition').inputSource).toBeUndefined()
  })
})

// TRIALDONE.2 — the un1t board only: exactly 2 attended and the trial has
// expired is Trial done. Stillorgan's Glofox board (classifyContact) is not moved.
describe('acquisition_un1t classify: 2 attended + expired trial', () => {
  const NOW = Date.parse('2026-10-19T12:00:00Z')
  const DAY = 86_400_000
  const ago = (d) => new Date(NOW - d * DAY).toISOString()
  const attendedAt = (d) => ({ attended: true, status: 'ATTENDED', time_start: Math.floor((NOW - d * DAY) / 1000) })
  const snapshot = (attendedDays, over = {}) => ({
    glofox_membership_status: 'lead',
    glofox_membership_state: null,
    glofox_membership_expiry: null,
    last_attended_at: attendedDays.length ? ago(Math.min(...attendedDays)) : null,
    total_attended_7d: null,
    total_attended_30d: null,
    last_payment_at: null,
    joined_at: ago(12),
    created_at: null,
    trial_credits_remaining: 0,
    recent_bookings: attendedDays.map(attendedAt),
    converted_at: null,
    pack_customer_at: null,
    pipeline_dismissed_at: null,
    last_lead_source_at: null,
    gympass_member_id: null,
    trial_expires_at: null,
    ...over,
  })

  it('2 attended + expired trial is trial_done', () => {
    expect(un1tClassify(snapshot([8, 5], { trial_expires_at: ago(1) }), NOW)).toBe('trial_done')
  })

  it('2 attended + unexpired trial stays second_class', () => {
    expect(un1tClassify(snapshot([8, 5], { trial_expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe('second_class')
    // no expiry known (no trial, or a product with none) is never "expired"
    expect(un1tClassify(snapshot([8, 5]), NOW)).toBe('second_class')
    expect(un1tClassify(snapshot([8, 5], { trial_expires_at: 'not a date' }), NOW)).toBe('second_class')
  })

  it('1 attended + expired stays first_class', () => {
    expect(un1tClassify(snapshot([5], { trial_expires_at: ago(1) }), NOW)).toBe('first_class')
  })

  it('3 attended is trial_done (unchanged)', () => {
    expect(un1tClassify(snapshot([9, 8, 5]), NOW)).toBe('trial_done')
    expect(un1tClassify(snapshot([9, 8, 5], { trial_expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe('trial_done')
  })

  it('every other stage is classifyContact\'s answer, untouched', () => {
    expect(un1tClassify(snapshot([8, 5], { trial_expires_at: ago(1), glofox_membership_status: 'member' }), NOW)).toBe('member')
    expect(un1tClassify(snapshot([], { trial_expires_at: ago(1) }), NOW)).toBe('new_lead')
  })

  it('the Glofox acquisition classify is unchanged for the same snapshot', () => {
    expect(glofoxClassify(snapshot([8, 5], { trial_expires_at: ago(1) }), NOW)).toBe('second_class')
  })
})
