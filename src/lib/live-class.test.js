// Tests for live-class.js — read paths use mocked Supabase chains;
// write paths are integration-flavoured (test the orchestration,
// not every SQL detail).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getLiveSessions,
  getAvailableStraps,
  pairOverride,
  endSession,
  endAllAtLocation,
} from './live-class.js'

beforeEach(() => { vi.clearAllMocks() })

// ── getLiveSessions ─────────────────────────────────────────────

describe('getLiveSessions', () => {
  function dbWith({ sessions, samples }) {
    return {
      from: vi.fn((table) => {
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(() => ({
                  order: vi.fn(() => Promise.resolve({ data: sessions, error: null })),
                })),
              })),
            })),
          }
        }
        if (table === 'hr_samples') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => ({
                gte: vi.fn(() => ({
                  order: vi.fn(() => Promise.resolve({ data: samples, error: null })),
                })),
              })),
            })),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
  }

  it('returns [] when no open sessions', async () => {
    const db = dbWith({ sessions: [], samples: [] })
    expect(await getLiveSessions(db, 'loc-1')).toEqual([])
  })

  it('returns sessions with averaged currentBpm from recent samples', async () => {
    const sessions = [
      {
        id: 'sess-1', contact_id: 'c-1', booking_id: 'b-1',
        started_at: '2026-05-08T17:00:00Z', max_hr_used: 200,
        device_identifier: 'AA:BB:CC:DD:EE:FF', last_sample_at: '2026-05-08T17:05:00Z',
        contacts: { id: 'c-1', name: 'Sarah Test', location_id: 'loc-1' },
      },
    ]
    const samples = [
      { session_id: 'sess-1', recorded_at: '2026-05-08T17:04:55Z', bpm: 144 },
      { session_id: 'sess-1', recorded_at: '2026-05-08T17:04:56Z', bpm: 146 },
      { session_id: 'sess-1', recorded_at: '2026-05-08T17:04:57Z', bpm: 145 },
    ]
    const out = await getLiveSessions(dbWith({ sessions, samples }), 'loc-1')
    expect(out).toHaveLength(1)
    expect(out[0].currentBpm).toBe(145)
    expect(out[0].contactFirstName).toBe('Sarah')
  })

  it('null currentBpm when no recent samples', async () => {
    const sessions = [{
      id: 'sess-1', contact_id: 'c-1', booking_id: null,
      started_at: '2026-05-08T17:00:00Z', max_hr_used: 200,
      device_identifier: 'AA:BB:CC:DD:EE:FF', last_sample_at: null,
      contacts: { id: 'c-1', name: 'Test User', location_id: 'loc-1' },
    }]
    const out = await getLiveSessions(dbWith({ sessions, samples: [] }), 'loc-1')
    expect(out[0].currentBpm).toBe(null)
  })
})

// ── getAvailableStraps ─────────────────────────────────────────

describe('getAvailableStraps', () => {
  it('returns [] when no bridges', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    }
    expect(await getAvailableStraps(db, 'loc-1')).toEqual([])
  })

  it('flattens bridges and filters out in-use straps across protocols', async () => {
    const bridgeRows = [{
      id: 'b-1', name: 'Studio 1', status: 'online', last_seen_at: '2026-05-08T17:00:00Z',
      last_seen_straps: [
        { device_key: 'ble:AA:BB:CC:DD:EE:FF', name: 'Polar H10', rssi: -50, last_bpm: 120, seen_at: '2026-05-08T17:00:00Z' },
        { device_key: 'ant:12345', name: null, rssi: null, last_bpm: 90, seen_at: '2026-05-08T17:00:00Z' },
      ],
    }]
    const inUseRows = [{ device_identifier: 'ble:AA:BB:CC:DD:EE:FF' }]
    const db = {
      from: vi.fn((table) => {
        if (table === 'ble_bridges') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: bridgeRows, error: null })),
            })),
          }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(() => ({
                  in: vi.fn(() => Promise.resolve({ data: inUseRows, error: null })),
                })),
              })),
            })),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
    const out = await getAvailableStraps(db, 'loc-1')
    expect(out).toHaveLength(1)
    expect(out[0].device_key).toBe('ant:12345')
    expect(out[0].protocol).toBe('ant')
  })
})

// ── pairOverride ────────────────────────────────────────────────

describe('pairOverride', () => {
  it('returns error when contact not found', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not found' } })),
          })),
        })),
      })),
    }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: 'ble:AA:BB:CC:DD:EE:FF',
    })
    expect(out.ok).toBe(false)
  })

  it('rejects a missing device_key before touching the DB', async () => {
    const db = { from: vi.fn(() => { throw new Error('should not query') }) }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: null,
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/device_key/)
  })

  it('reuses existing open session when present and inserts strap_assignments', async () => {
    const calls = { saInsert: null, saUpdate: null }
    const db = {
      from: vi.fn((table) => {
        if (table === 'contacts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({
                  data: { id: 'c-1', max_hr_override: null, dob: '1990-05-08' },
                  error: null,
                })),
              })),
            })),
          }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    order: vi.fn(() => ({
                      limit: vi.fn(() => ({
                        maybeSingle: vi.fn(() => Promise.resolve({
                          data: { id: 'sess-existing', device_identifier: 'ble:AA:BB:CC:DD:EE:FF' },
                          error: null,
                        })),
                      })),
                    })),
                  })),
                })),
              })),
            })),
            update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          }
        }
        if (table === 'class_occurrences') {
          // No live class running — existing session returned unchanged.
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                gte: vi.fn(() => ({
                  lte: vi.fn(() => ({
                    order: vi.fn(() => Promise.resolve({ data: [], error: null })),
                  })),
                })),
              })),
            })),
          }
        }
        if (table === 'strap_assignments') {
          return {
            insert: vi.fn((row) => {
              calls.saInsert = row
              return Promise.resolve({ error: null })
            }),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: 'ble:AA:BB:CC:DD:EE:FF',
    })
    expect(out.ok).toBe(true)
    expect(out.sessionId).toBe('sess-existing')
    expect(calls.saInsert).toMatchObject({
      ble_bridge_id: 'b-1',
      contact_id: 'c-1',
      strap_identifier: 'ble:AA:BB:CC:DD:EE:FF',
      heart_rate_session_id: 'sess-existing',
    })
  })

  it('stamps class_link_source=booked when the member is booked into the live class', async () => {
    const NOW = Date.parse('2026-06-18T05:30:00Z') // mid a 05:00–06:00Z class
    let insertedSession = null
    const db = {
      from: vi.fn((table) => {
        if (table === 'contacts') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({
            data: { id: 'c-1', max_hr_override: null, dob: '1990-05-08', glofox_member_id: 'm1' }, error: null,
          })) })) })) }
        }
        if (table === 'class_occurrences') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: [
              { glofox_event_id: 'ev1', name: 'DR1VE', starts_at: '2026-06-18T05:00:00Z', ends_at: '2026-06-18T06:00:00Z' },
            ] })),
          })) })) })) })) }
        }
        if (table === 'class_bookings') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({
            not: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: [{ id: 'bk1' }] })) })),
          })) })) })) })) }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => ({
              limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
            })) })) })) })) })),
            insert: vi.fn((row) => { insertedSession = row; return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'sess-new' }, error: null })) })) } }),
          }
        }
        if (table === 'strap_assignments') {
          return { insert: vi.fn(() => Promise.resolve({ error: null })) }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: 'ble:AA:BB:CC:DD:EE:FF', nowMs: NOW,
    })
    expect(out.ok).toBe(true)
    expect(out.sessionId).toBe('sess-new')
    expect(insertedSession.class_link_source).toBe('booked')
    expect(insertedSession.glofox_event_id).toBe('ev1')
  })
})

// ── endSession ─────────────────────────────────────────────────

describe('endSession', () => {
  it('returns { alreadyEnded: true } when session already has ended_at', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({
              data: { id: 'sess-1', max_hr_used: 200, ended_at: '2026-05-08T17:00:00Z' },
              error: null,
            })),
          })),
        })),
      })),
    }
    const out = await endSession(db, 'sess-1')
    expect(out).toEqual({ ok: true, alreadyEnded: true })
  })

  it('happy path: writes summary + closes strap_assignments', async () => {
    let updatedSessionRow = null
    let updatedSaRows = null
    const samples = [
      { recorded_at: '2026-05-08T17:00:00Z', bpm: 145 },
      { recorded_at: '2026-05-08T17:00:01Z', bpm: 146 },
    ]
    const db = {
      from: vi.fn((table) => {
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({
                  data: { id: 'sess-1', max_hr_used: 200, ended_at: null },
                  error: null,
                })),
              })),
            })),
            update: vi.fn((row) => {
              updatedSessionRow = row
              return { eq: vi.fn(() => Promise.resolve({ error: null })) }
            }),
          }
        }
        if (table === 'hr_samples') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({ data: samples, error: null })),
              })),
            })),
          }
        }
        if (table === 'strap_assignments') {
          return {
            update: vi.fn((row) => {
              updatedSaRows = row
              return {
                eq: vi.fn(() => ({
                  is: vi.fn(() => Promise.resolve({ error: null })),
                })),
              }
            }),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
    const out = await endSession(db, 'sess-1')
    expect(out.ok).toBe(true)
    expect(updatedSessionRow.ended_at).toBeTruthy()
    expect(updatedSessionRow.avg_hr_bpm).toBeGreaterThan(0)
    expect(updatedSessionRow.zones_seconds).toBeTruthy()
    expect(updatedSaRows.ended_at).toBeTruthy()
  })
})

// ── endAllAtLocation ───────────────────────────────────────────

describe('endAllAtLocation', () => {
  it('returns ended:0 when no open sessions', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
    }
    expect(await endAllAtLocation(db, 'loc-1')).toEqual({ ok: true, ended: 0 })
  })
})
