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
  finalizeSessionRewards,
  createParticipationSession,
} from './live-class.js'
import { sendPostClassEmail } from '@/lib/hr-post-class-email'
import { runDetectionForSession } from '@/lib/achievements'
import { enqueueExportsForSession } from '@/lib/external-export'

vi.mock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/achievements', () => ({ runDetectionForSession: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/external-export', () => ({ enqueueExportsForSession: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(() => Promise.resolve({ sent: 0, invalidated: 0 })) }))

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

  it('labels an anonymous (null-contact) session by its device id', async () => {
    const sessions = [{
      id: 'sess-anon', contact_id: null, booking_id: null,
      started_at: '2026-06-18T05:30:00Z', max_hr_used: 180,
      device_identifier: 'ant:45075', last_sample_at: null,
      contacts: null,
    }]
    const out = await getLiveSessions(dbWith({ sessions, samples: [] }), 'loc-1')
    expect(out[0].contactName).toBe('ant:45075')
    expect(out[0].contactFirstName).toBe('ant:45075')
    expect(out[0].contactId).toBeNull()
    expect(out[0].glofoxMemberId).toBeNull()
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
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
            })),
          })),
        })),
      })),
    }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: 'ble:AA:BB:CC:DD:EE:FF',
    })
    expect(out.ok).toBe(false)
  })

  it('rejects a contact at a DIFFERENT location (IDOR guard)', async () => {
    // The location_id .eq filter yields no row → maybeSingle returns null.
    let queriedLocation = null
    const db = {
      from: vi.fn((table) => {
        if (table !== 'contacts') throw new Error(`should not query ${table}`)
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn((col, val) => {
                if (col === 'location_id') queriedLocation = val
                return { maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) }
              }),
            })),
          })),
        }
      }),
    }
    const out = await pairOverride(db, {
      locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-other-loc', deviceKey: 'ble:AA:BB:CC:DD:EE:FF',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/this location/)
    expect(queriedLocation).toBe('loc-1')
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
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(() => Promise.resolve({
                    data: { id: 'c-1', max_hr_override: null, dob: '1990-05-08', location_id: 'loc-1' },
                    error: null,
                  })),
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
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({
            data: { id: 'c-1', max_hr_override: null, dob: '1990-05-08', glofox_member_id: 'm1', location_id: 'loc-1' }, error: null,
          })) })) })) })) }
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
  it('skips contact-bound side-effects for an anonymous (null-contact) session', async () => {
    const db = {
      from: vi.fn((table) => {
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'sess-anon', contact_id: null, location_id: 'loc-1', max_hr_used: 180, ended_at: null }, error: null })) })) })),
            update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          }
        }
        if (table === 'locations') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'loc-1', settings: {} }, error: null })) })) })) }
        }
        if (table === 'hr_samples') {
          // endSession now pages samples: .select().eq().order().range().
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(() => ({ range: vi.fn(() => Promise.resolve({ data: [{ recorded_at: '2026-06-18T05:30:00Z', bpm: 150 }], error: null })) })) })) })) }
        }
        if (table === 'strap_assignments') {
          return { update: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => Promise.resolve({ error: null })) })) })) }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
    const out = await endSession(db, 'sess-anon')
    expect(out.ok).toBe(true)
    expect(out.summary).toBeTruthy()
    expect(sendPostClassEmail).not.toHaveBeenCalled()
    expect(runDetectionForSession).not.toHaveBeenCalled()
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
  })

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
                  data: { id: 'sess-1', contact_id: null, location_id: 'loc-1', max_hr_used: 200, ended_at: null },
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
        if (table === 'locations') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'loc-1', settings: {} }, error: null })) })) })) }
        }
        if (table === 'hr_samples') {
          // endSession now pages samples: .select().eq().order().range().
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  range: vi.fn(() => Promise.resolve({ data: samples, error: null })),
                })),
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

// ── createParticipationSession ─────────────────────────────────

describe('createParticipationSession', () => {
  it('builds the participation insert payload and returns the new id', async () => {
    let insertedRow = null
    const db = {
      from: vi.fn((table) => {
        if (table !== 'heart_rate_sessions') throw new Error(`unexpected ${table}`)
        return {
          insert: vi.fn((row) => {
            insertedRow = row
            return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'sess-part' }, error: null })) })) }
          }),
        }
      }),
    }
    const id = await createParticipationSession(db, {
      contactId: 'c-1',
      locationId: 'loc-1',
      glofoxEventId: 'ev-1',
      className: 'DR1VE',
      startedAtIso: '2026-06-20T05:00:00Z',
      endedAtIso: '2026-06-20T06:00:00Z',
      participationPoints: 50,
      maxHr: 180,
    })
    expect(id).toBe('sess-part')
    expect(insertedRow).toMatchObject({
      contact_id: 'c-1',
      location_id: 'loc-1',
      source: 'participation',
      device_identifier: null,
      started_at: '2026-06-20T05:00:00Z',
      ended_at: '2026-06-20T06:00:00Z',
      max_hr_used: 180,
      zones_seconds: {},
      effort_points: 50,
      glofox_event_id: 'ev-1',
      class_name: 'DR1VE',
      class_link_source: 'booked',
    })
    // ended_at must be set (standings filter on ended_at IS NOT NULL) and the
    // CHECK-constrained link source must be 'booked', never 'attended'.
    expect(insertedRow.ended_at).toBeTruthy()
    expect(insertedRow.class_link_source).not.toBe('attended')
  })

  it('returns null on insert failure', async () => {
    const db = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })) })) })),
      })),
    }
    const id = await createParticipationSession(db, {
      contactId: 'c-1', locationId: 'loc-1', glofoxEventId: null, className: null,
      startedAtIso: '2026-06-20T05:00:00Z', endedAtIso: '2026-06-20T06:00:00Z',
      participationPoints: 50, maxHr: 180,
    })
    expect(id).toBeNull()
  })
})

// ── finalizeSessionRewards ─────────────────────────────────────

describe('finalizeSessionRewards', () => {
  // Permissive db: returns the given session row for the first
  // heart_rate_sessions select, and empty/null for everything the cascade
  // touches afterward (goals, locations, monthSessions) so it flows straight
  // through to the export-enqueue decision without side-effects.
  function dbForSession(sessionRow) {
    // Project sessionRow down to exactly the columns named in the SELECT
    // string — mirrors PostgREST, so a column the production code forgets to
    // select comes back `undefined` here too. This is what makes the
    // export-enqueue regression (missing `ended_at` in the SELECT) detectable:
    // a column-blind mock would always return ended_at and hide the bug.
    const project = (columns) => {
      if (typeof columns !== 'string') return sessionRow
      const fields = columns.split(',').map((c) => c.trim())
      const out = {}
      for (const f of fields) if (f in sessionRow) out[f] = sessionRow[f]
      return out
    }
    return {
      from: vi.fn((table) => {
        if (table === 'heart_rate_sessions') {
          return {
            // session load (.select().eq().single()) AND the goal/month
            // sessions reads (.select().eq().not().gte() / .eq().eq().not().gte())
            select: vi.fn((columns) => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: project(columns), error: null })),
                not: vi.fn(() => ({ gte: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
                eq: vi.fn(() => ({ not: vi.fn(() => ({ gte: vi.fn(() => Promise.resolve({ data: [], error: null })) })) })),
              })),
            })),
          }
        }
        if (table === 'contact_goals') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => Promise.resolve({ data: [], error: null })) })) })) })) }
        }
        if (table === 'locations') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'loc-1', settings: {} }, error: null })) })) })) }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
  }

  it('returns early with no side-effects when the session has no contact_id', async () => {
    const db = {
      from: vi.fn((table) => {
        if (table !== 'heart_rate_sessions') throw new Error(`unexpected ${table}`)
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'sess-anon', contact_id: null, source: 'ble_bridge' }, error: null })) })) })) }
      }),
    }
    await finalizeSessionRewards(db, 'sess-anon')
    expect(sendPostClassEmail).not.toHaveBeenCalled()
    expect(runDetectionForSession).not.toHaveBeenCalled()
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
  })

  it('enqueues the external export for a normal (HR) session', async () => {
    const db = dbForSession({
      id: 'sess-1', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 42, ended_at: '2026-06-20T06:00:00Z',
      source: 'ble_bridge', glofox_event_id: 'ev-1', class_name: 'DR1VE',
    })
    await finalizeSessionRewards(db, 'sess-1')
    expect(enqueueExportsForSession).toHaveBeenCalledTimes(1)
    // Regression guard: the export MUST receive a truthy ended_at — without it
    // enqueueExportsForSession early-returns and the Strava auto-export is
    // silently skipped for every session. The SELECT in finalizeSessionRewards
    // must include ended_at for this to resolve.
    expect(enqueueExportsForSession).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'sess-1', contact_id: 'c-1', ended_at: expect.any(String) })
    )
  })

  it('skips the external export for a participation session', async () => {
    const db = dbForSession({
      id: 'sess-part', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 50, started_at: '2026-06-20T05:00:00Z',
      source: 'participation', glofox_event_id: 'ev-1', class_name: 'DR1VE',
    })
    await finalizeSessionRewards(db, 'sess-part')
    // The contact-bound cascade still runs (it has a contact_id) ...
    expect(sendPostClassEmail).toHaveBeenCalledTimes(1)
    // ... but participation rows have no HR samples to push externally.
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
  })

  // ── IB3: import-tailored finalisation ────────────────────────────
  // Imported Apple workouts (source='apple_health') reuse the reward cascade
  // (points/achievements/goals/tiers all earned), but two steps are tailored:
  // the post-class email is class-only, and external-export is bridge-only.

  it('sends the post-class email for a ble_bridge session (unchanged live path)', async () => {
    const db = dbForSession({
      id: 'sess-bridge', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 42, ended_at: '2026-06-20T06:00:00Z',
      source: 'ble_bridge', glofox_event_id: 'ev-1', class_name: 'DR1VE',
    })
    await finalizeSessionRewards(db, 'sess-bridge')
    expect(sendPostClassEmail).toHaveBeenCalledTimes(1)
    // ble_bridge is our own captured live session — it also exports.
    expect(enqueueExportsForSession).toHaveBeenCalledTimes(1)
  })

  it('sends the post-class email for an apple_health import WITH a glofox_event_id', async () => {
    // An imported workout that fell inside a class window (IB5 stamps the
    // glofox_event_id) IS a class session → it gets the post-class email.
    const db = dbForSession({
      id: 'sess-apple-class', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 38, ended_at: '2026-06-20T06:00:00Z',
      source: 'apple_health', glofox_event_id: 'ev-1', class_name: 'DR1VE',
    })
    await finalizeSessionRewards(db, 'sess-apple-class')
    expect(sendPostClassEmail).toHaveBeenCalledTimes(1)
    // ...but imported wearable data is never re-exported, even when class-linked.
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
  })

  it('SKIPS the post-class email for an apple_health import WITHOUT a glofox_event_id', async () => {
    // An off-site run with no class link is not a class — no "your class is
    // ready" email, and no re-export to Strava.
    const db = dbForSession({
      id: 'sess-apple-offsite', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 71, ended_at: '2026-06-20T06:00:00Z',
      source: 'apple_health', glofox_event_id: null, class_name: null,
    })
    await finalizeSessionRewards(db, 'sess-apple-offsite')
    expect(sendPostClassEmail).not.toHaveBeenCalled()
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
    // ...but the points-earning cascade still ran (achievement detection fired).
    expect(runDetectionForSession).toHaveBeenCalledTimes(1)
  })

  it('does NOT enqueue the external export for an apple_health import (class-linked or not)', async () => {
    const db = dbForSession({
      id: 'sess-apple', contact_id: 'c-1', location_id: 'loc-1',
      effort_points: 60, ended_at: '2026-06-20T06:00:00Z',
      source: 'apple_health', glofox_event_id: 'ev-9', class_name: 'DR1VE',
    })
    await finalizeSessionRewards(db, 'sess-apple')
    expect(enqueueExportsForSession).not.toHaveBeenCalled()
  })
})
