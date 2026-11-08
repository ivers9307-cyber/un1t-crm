// HOSTSERIES.1 — syncEventSessions: the host form's sessions[] become
// race_waves rows. Deletes are checked for live entries BEFORE any write; a
// swap of two times is refused whole (UNIQUE (race_event_id, start_time)).
import { describe, it, expect } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'
import { syncEventSessions, sessionsFromWaves } from './event-sessions.js'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'

const current = [
  { id: W1, start_time: '10:00:00', label: null, capacity: 20, display_order: 0 },
  { id: W2, start_time: '14:00:00', label: 'Afternoon', capacity: 15, display_order: 1 },
]

// `counts` answers the live-entry count per wave id; `failWrite` makes a
// given action answer an error.
function db({ counts = {}, failWrite = null, countError = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_registrations') {
      if (countError) return { count: null, error: countError }
      const waveId = q.ops.find((o) => o[0] === 'eq' && o[1] === 'wave_id')?.[2]
      return { count: counts[waveId] || 0, error: null }
    }
    if (q.table === 'race_waves') {
      if (failWrite && q.action === failWrite.action) return { data: null, error: failWrite.error }
      if (q.action === 'insert') return { data: (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r, i) => ({ id: `new-${i}`, ...r })), error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}
const wavesQueries = (d) => d.queries.filter((q) => q.table === 'race_waves')

describe('sessionsFromWaves', () => {
  it('orders by display_order then time and slices HH:MM:SS to HH:MM', () => {
    const out = sessionsFromWaves([
      { id: W2, start_time: '14:00:00', label: 'Afternoon', capacity: 15, display_order: 1 },
      { id: W1, start_time: '10:00:00', label: null, capacity: 20, display_order: 0 },
    ])
    expect(out).toEqual([
      { id: W1, start_time: '10:00', label: null, capacity: 20 },
      { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 },
    ])
  })
  it('is empty for no waves', () => {
    expect(sessionsFromWaves(null)).toEqual([])
  })
})

describe('syncEventSessions', () => {
  it('deletes removed, updates kept and inserts new, in that order', async () => {
    const d = db()
    const r = await syncEventSessions(d, {
      eventId: E1,
      sessions: [{ id: W1, start_time: '10:30', label: 'Morning', capacity: 25 }, { start_time: '18:00', label: null, capacity: 10 }],
      currentWaves: current,
    })
    expect(r.ok).toBe(true)
    const ops = wavesQueries(d).map((q) => q.action)
    expect(ops).toEqual(['delete', 'update', 'insert'])
    const [del, upd, ins] = wavesQueries(d)
    expect(del.ops).toContainEqual(['in', 'id', [W2]])
    expect(upd.payload).toMatchObject({ start_time: '10:30', label: 'Morning', capacity: 25, display_order: 0 })
    expect(upd.ops).toContainEqual(['eq', 'id', W1])
    expect(ins.payload).toEqual([{ race_event_id: E1, start_time: '18:00', label: null, capacity: 10, display_order: 1 }])
  })

  it('refuses to delete a session with live entries, naming its time, before any write', async () => {
    const d = db({ counts: { [W2]: 3 } })
    const r = await syncEventSessions(d, { eventId: E1, sessions: [{ id: W1, start_time: '10:00', capacity: 20 }], currentWaves: current })
    expect(r).toMatchObject({ ok: false, error: 'session_has_entries', session_time: '14:00' })
    expect(r.message).toMatch(/14:00/)
    expect(wavesQueries(d)).toHaveLength(0)
  })

  it('a swap of two times is refused whole', async () => {
    const d = db()
    const r = await syncEventSessions(d, {
      eventId: E1,
      sessions: [{ id: W1, start_time: '14:00', capacity: 20 }, { id: W2, start_time: '10:00', capacity: 15 }],
      currentWaves: current,
    })
    expect(r).toMatchObject({ ok: false, error: 'duplicate_session_time' })
    expect(wavesQueries(d)).toHaveLength(0)
  })

  it('a new session at a kept session\'s old time is refused whole too', async () => {
    const d = db()
    const r = await syncEventSessions(d, {
      eventId: E1,
      sessions: [{ id: W1, start_time: '11:00', capacity: 20 }, { id: W2, start_time: '14:00', capacity: 15 }, { start_time: '10:00', capacity: 5 }],
      currentWaves: current,
    })
    expect(r).toMatchObject({ ok: false, error: 'duplicate_session_time' })
    expect(wavesQueries(d)).toHaveLength(0)
  })

  it('a failed live-entry count is write_failed, not a delete', async () => {
    const d = db({ countError: { message: 'timeout' } })
    const r = await syncEventSessions(d, { eventId: E1, sessions: [{ id: W1, start_time: '10:00', capacity: 20 }], currentWaves: current })
    expect(r).toMatchObject({ ok: false, error: 'write_failed' })
    expect(wavesQueries(d)).toHaveLength(0)
  })

  it('a 23505 from the database is duplicate_session_time; any other write error is write_failed', async () => {
    const dup = db({ failWrite: { action: 'update', error: { code: '23505', message: 'duplicate key' } } })
    const r1 = await syncEventSessions(dup, { eventId: E1, sessions: [{ id: W1, start_time: '10:30', capacity: 20 }, { id: W2, start_time: '14:00', capacity: 15 }], currentWaves: current })
    expect(r1).toMatchObject({ ok: false, error: 'duplicate_session_time' })
    const down = db({ failWrite: { action: 'insert', error: { code: '57014', message: 'down' } } })
    const r2 = await syncEventSessions(down, { eventId: E1, sessions: [{ id: W1, start_time: '10:00', capacity: 20 }, { id: W2, start_time: '14:00', capacity: 15 }, { start_time: '18:00', capacity: 5 }], currentWaves: current })
    expect(r2).toMatchObject({ ok: false, error: 'write_failed' })
  })

  it('no removed waves means no count read', async () => {
    const d = db()
    await syncEventSessions(d, { eventId: E1, sessions: [{ id: W1, start_time: '10:00', capacity: 20 }, { id: W2, start_time: '14:00', capacity: 15 }], currentWaves: current })
    expect(d.queries.filter((q) => q.table === 'race_registrations')).toHaveLength(0)
  })
})
