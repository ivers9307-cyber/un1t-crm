// Route tests for the direct Apple Health ingest endpoint. The IO deps
// (Supabase, member-auth, reward cascade, class-correlation) are mocked; the
// pure mapper + scoring run for real on the fixtures.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/customer-auth', () => ({ resolveCustomerContact: vi.fn() }))
vi.mock('@/lib/live-class', () => ({ finalizeSessionRewards: vi.fn(async () => {}) }))
vi.mock('@/lib/class-occurrences', () => ({ resolveCurrentOccurrence: vi.fn(async () => null) }))
vi.mock('@/lib/class-bookings', () => ({ lookupBookedMember: vi.fn(async () => false) }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { finalizeSessionRewards } from '@/lib/live-class'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { lookupBookedMember } from '@/lib/class-bookings'

const WORKOUT = {
  id: 'HK-UUID-1', type: 'running',
  start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:40:00Z',
  avg_heart_rate_bpm: 150, max_heart_rate_bpm: 178, calories_kcal: 420,
}
function reqWith(body) { return { json: async () => body } }

// In-memory Supabase mock: per-table maybeSingle fixtures, records inserts + upserts.
function makeDb({ location = { id: 'loc-1', settings: {} }, existingWorkout = null, richer = null } = {}) {
  const inserts = []
  const upserts = []
  function from(table) {
    const b = {}
    b.select = () => b
    b.eq = () => b
    b.neq = () => { b._dedupKind = 'richer'; return b }
    b.filter = () => { b._dedupKind = 'workout'; return b }
    b.limit = () => b
    b.insert = (payload) => { b._payload = payload; return b }
    b.upsert = (rows) => { upserts.push({ table, rows }); return Promise.resolve({ error: null }) }
    b.maybeSingle = () => {
      if (table === 'locations') return Promise.resolve({ data: location })
      if (table === 'contacts') return Promise.resolve({ data: { glofox_member_id: 'gm-1' } })
      if (table === 'heart_rate_sessions') {
        return Promise.resolve({ data: b._dedupKind === 'richer' ? richer : existingWorkout })
      }
      return Promise.resolve({ data: null })
    }
    b.single = () => {
      inserts.push({ table, payload: b._payload })
      return Promise.resolve({ data: { id: 'sess-new' }, error: null })
    }
    return b
  }
  return { from, _inserts: inserts, _upserts: upserts }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveCustomerContact.mockResolvedValue({ contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: 185, dob: null } })
  // Defaults: no live class, not booked (mockResolvedValue survives clearAllMocks,
  // so reset here to keep class-correlation cases from leaking into other tests).
  resolveCurrentOccurrence.mockResolvedValue(null)
  lookupBookedMember.mockResolvedValue(false)
})

describe('POST /api/wearables/apple-health/ingest', () => {
  it('401 when the member token is unauthorised', async () => {
    resolveCustomerContact.mockResolvedValue({ error: 'unauthorised' })
    const res = await POST(reqWith({ workouts: [{ workout: WORKOUT }] }))
    expect(res.status).toBe(401)
    expect(createServerClient).toHaveBeenCalled() // db built, but no work
  })

  it('409 when the token is valid but no linked contact', async () => {
    resolveCustomerContact.mockResolvedValue({ error: 'no_contact' })
    const res = await POST(reqWith({ workouts: [] }))
    expect(res.status).toBe(409)
  })

  it('fresh workout → inserts an apple_health session + finalises', async () => {
    const db = makeDb({ existingWorkout: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(reqWith({ workouts: [{ workout: WORKOUT, hrSamples: [] }] }))
    const json = await res.json()
    expect(json).toEqual(expect.objectContaining({ success: true, ingested: 1, deduped: 0, finalised: 1 }))
    expect(db._inserts).toHaveLength(1)
    const row = db._inserts[0].payload
    expect(row.source).toBe('apple_health')
    expect(row.contact_id).toBe('c-1')
    expect(row.location_id).toBe('loc-1')
    expect(row.max_hr_used).toBe(185)
    expect(row.raw_metadata.apple_workout_uuid).toBe('HK-UUID-1')
    expect(row.avg_hr_bpm).toBe(150) // no HR samples → aggregates
    expect(finalizeSessionRewards).toHaveBeenCalledWith(db, 'sess-new', expect.objectContaining({ nowMs: expect.any(Number) }))
  })

  it('class running but member NOT booked → session has NO class association (no name/points/email)', async () => {
    const db = makeDb({ existingWorkout: null })
    createServerClient.mockReturnValue(db)
    resolveCurrentOccurrence.mockResolvedValue({ glofox_event_id: 'evt-1', class_name: 'PACE - STRENGTH' })
    lookupBookedMember.mockResolvedValue(false)
    const res = await POST(reqWith({ workouts: [{ workout: WORKOUT }] }))
    expect((await res.json()).ingested).toBe(1)
    const row = db._inserts[0].payload
    expect(row.glofox_event_id ?? null).toBeNull()
    expect(row.class_name ?? null).toBeNull()
    expect(row.class_link_source ?? null).toBeNull()
  })

  it('class running AND member booked → session associated with the class', async () => {
    const db = makeDb({ existingWorkout: null })
    createServerClient.mockReturnValue(db)
    resolveCurrentOccurrence.mockResolvedValue({ glofox_event_id: 'evt-1', class_name: 'PACE - STRENGTH' })
    lookupBookedMember.mockResolvedValue(true)
    const res = await POST(reqWith({ workouts: [{ workout: WORKOUT }] }))
    expect((await res.json()).ingested).toBe(1)
    const row = db._inserts[0].payload
    expect(row.glofox_event_id).toBe('evt-1')
    expect(row.class_name).toBe('PACE - STRENGTH')
    expect(row.class_link_source).toBe('booked')
  })

  it('re-uploaded workout (already ingested) → deduped, no insert', async () => {
    const db = makeDb({ existingWorkout: { id: 'sess-old' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(reqWith({ workouts: [{ workout: WORKOUT }] }))
    const json = await res.json()
    expect(json.ingested).toBe(0)
    expect(json.deduped).toBe(1)
    expect(db._inserts).toHaveLength(0)
    expect(finalizeSessionRewards).not.toHaveBeenCalled()
  })

  it('health metrics → upserted into member_health_metrics with source apple_health', async () => {
    const db = makeDb({ existingWorkout: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(reqWith({
      workouts: [],
      healthMetrics: [
        { metric: 'resting_heart_rate', recorded_at: '2026-06-23T06:00:00Z', value: 52, unit: 'bpm' },
        { metric: 'vo2max', recorded_at: '2026-06-23T06:00:00Z', value: 48 },
        { metric: 'bad', recorded_at: '2026-06-23T06:00:00Z', value: null }, // dropped
      ],
    }))
    const json = await res.json()
    expect(json.metricsUpserted).toBe(2)
    expect(db._upserts).toHaveLength(1)
    expect(db._upserts[0].table).toBe('member_health_metrics')
    expect(db._upserts[0].rows).toHaveLength(2)
    expect(db._upserts[0].rows[0]).toEqual(expect.objectContaining({ contact_id: 'c-1', metric: 'resting_heart_rate', source: 'apple_health' }))
  })

  it('skips a workout missing its id/start_time (no dedup key / time anchor)', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(reqWith({ workouts: [{ workout: { type: 'running' } }] }))
    const json = await res.json()
    expect(json.ingested).toBe(0)
    expect(db._inserts).toHaveLength(0)
  })
})
