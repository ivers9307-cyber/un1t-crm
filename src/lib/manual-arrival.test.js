// ARRIVALFIX.1 — the manual-arrival rules. Synthetic data only (public repo).
import { describe, it, expect } from 'vitest'
import { decideManualArrival, manualArrivalAction, isPhoneArrival } from './manual-arrival'

const ZONE = 'Europe/Dublin'
const NOW = Date.parse('2026-07-15T12:00:00Z') // 13:00 in Dublin (summer time)
const a = (over = {}) => ({ id: 'a1', status: 'scheduled', arrived_at: null, arrival_source: null, block: { block_date: '2026-07-15' }, ...over })

describe('decideManualArrival', () => {
  it("turns the studio's wall clock into the instant (summer time, never Zulu)", () => {
    expect(decideManualArrival({ assignment: a(), time: '06:55', zone: ZONE, nowMs: NOW }))
      .toEqual({ ok: true, arrivedAt: '2026-07-15T05:55:00.000Z' })
  })
  it('the same wall clock in another zone is another instant', () => {
    expect(decideManualArrival({ assignment: a(), time: '06:55', zone: 'America/New_York', nowMs: Date.parse('2026-07-16T00:00:00Z') }).arrivedAt)
      .toBe('2026-07-15T10:55:00.000Z')
  })
  it('refuses a future time', () => {
    expect(decideManualArrival({ assignment: a(), time: '13:30', zone: ZONE, nowMs: NOW }))
      .toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/future/) })
  })
  it('ARRIVALFIX.2 — corrects a phone (geofence) stamp, at the studio clock', () => {
    expect(decideManualArrival({ assignment: a({ arrived_at: '2026-07-15T05:50:00Z', arrival_source: 'geofence' }), time: '06:00', zone: ZONE, nowMs: NOW }))
      .toEqual({ ok: true, arrivedAt: '2026-07-15T05:00:00.000Z' })
  })
  it('ARRIVALFIX.2 — a phone stamp in winter (GMT) is the same wall clock, another offset', () => {
    expect(decideManualArrival({ assignment: a({ arrived_at: '2026-01-15T06:50:00Z', arrival_source: 'geofence', block: { block_date: '2026-01-15' } }), time: '07:05', zone: ZONE, nowMs: NOW }))
      .toEqual({ ok: true, arrivedAt: '2026-01-15T07:05:00.000Z' })
  })
  it('ARRIVALFIX.2 — a phone stamp still refuses a future time', () => {
    expect(decideManualArrival({ assignment: a({ arrived_at: '2026-07-15T05:50:00Z', arrival_source: 'geofence' }), time: '13:30', zone: ZONE, nowMs: NOW }))
      .toMatchObject({ ok: false, status: 400 })
  })
  it('corrects a manual stamp', () => {
    expect(decideManualArrival({ assignment: a({ arrived_at: '2026-07-15T05:50:00Z', arrival_source: 'manual' }), time: '07:10', zone: ZONE, nowMs: NOW }))
      .toEqual({ ok: true, arrivedAt: '2026-07-15T06:10:00.000Z' })
  })
  it('a cancelled or missing assignment is not found', () => {
    expect(decideManualArrival({ assignment: a({ status: 'cancelled' }), time: '07:00', zone: ZONE, nowMs: NOW }).status).toBe(404)
    expect(decideManualArrival({ assignment: null, time: '07:00', zone: ZONE, nowMs: NOW }).status).toBe(404)
  })
  it('refuses a malformed time', () => {
    expect(decideManualArrival({ assignment: a(), time: '7am', zone: ZONE, nowMs: NOW }).status).toBe(400)
    expect(decideManualArrival({ assignment: a(), time: '24:00', zone: ZONE, nowMs: NOW }).status).toBe(400)
  })
})

describe('manualArrivalAction', () => {
  it("'add' when there is no arrival", () => {
    expect(manualArrivalAction({ actual_start: null, sources: [] })).toBe('add')
  })
  it("'edit' for a hand-entered arrival", () => {
    expect(manualArrivalAction({ actual_start: '07:00:00', sources: ['manual'] })).toBe('edit')
  })
  it("ARRIVALFIX.2 — 'edit' for a phone arrival, and for one corrected before", () => {
    expect(manualArrivalAction({ actual_start: '07:00:00', sources: ['geofence'] })).toBe('edit')
    expect(manualArrivalAction({ actual_start: '07:00:00', sources: ['geofence', 'manual'] })).toBe('edit')
  })
  it('nothing for an inferred "on site" arrival', () => {
    expect(manualArrivalAction({ actual_start: '08:00:00', arrival_inferred: true, sources: [] })).toBeNull()
  })
})

describe('isPhoneArrival (ARRIVALFIX.2)', () => {
  it('true only for a stamp the phone recorded and nobody has corrected', () => {
    expect(isPhoneArrival({ actual_start: '07:00:00', sources: ['geofence'] })).toBe(true)
    expect(isPhoneArrival({ actual_start: '07:00:00', sources: ['geofence', 'manual'] })).toBe(false)
    expect(isPhoneArrival({ actual_start: '07:00:00', sources: ['manual'] })).toBe(false)
    expect(isPhoneArrival({ actual_start: null, sources: ['geofence'] })).toBe(false)
  })
})
