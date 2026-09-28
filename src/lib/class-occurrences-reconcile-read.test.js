// CRONREADERR.1 — the class sync's cancellation (reconcile) step. A failed read
// of the spine's live rows used to read as "nothing to cancel" with no trace.
// It still cancels nothing (fail SAFE: never nuke the spine), but it is now
// logged and reported (reconcileFailed), and the sync stays ok because the
// upsert happened. Events here carry no trainer ids, so neither main's nor
// C3's trainer path touches the database or Glofox.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const fetchUpcomingEvents = vi.fn()
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchUpcomingEvents: (...a) => fetchUpcomingEvents(...a),
  fetchGlofoxTrainers: vi.fn(async () => []),
  fetchMemberResult: vi.fn(async () => ({ ok: false, member: null })),
}))

import { syncOccurrencesForLocation } from './class-occurrences.js'
import { logError, logWarn } from '@/lib/log'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-06-18T05:40:00.000Z')
const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const READ_ERR = { message: 'canceling statement due to statement timeout', code: '57014' }

const glofoxEvent = (id, startOffsetMin = 60) => ({
  _id: id, name: 'Strength 45', time_start: Math.floor((NOW + startOffsetMin * 60_000) / 1000), duration: 45, active: true,
})

// Minimal fake: the reconcile SELECT on class_occurrences answers `readResult`;
// UPDATEs answer `updateResult` and are recorded; the upsert succeeds.
function makeDb({ readResult = { data: [], error: null }, updateResult = { data: null, error: null } } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      const b = { op: 'select', patch: null }
      for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'is', 'not', 'order', 'limit']) b[m] = () => b
      b.update = (patch) => { b.op = 'update'; b.patch = patch; return b }
      b.upsert = () => { b.op = 'upsert'; return b }
      b.then = (resolve, reject) => {
        let out = { data: null, error: null }
        if (b.op === 'update') { updates.push(b.patch); out = updateResult }
        else if (b.op === 'select' && table === 'class_occurrences') out = readResult
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchUpcomingEvents.mockReset().mockResolvedValue({ ok: true, events: [glofoxEvent('evt-live')] })
})

describe('syncOccurrencesForLocation — reconcile read errors (CRONREADERR.1)', () => {
  it('a failed reconcile read cancels nothing, is logged, and is reported; the upsert still counts', async () => {
    const db = makeDb({ readResult: { data: null, error: READ_ERR } })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out).toMatchObject({ ok: true, upserted: 1, cancelled: 0, reconcileFailed: true })
    expect(db.updates.filter((p) => 'cancelled_at' in p)).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith(
      'class-occurrences',
      'cancel reconcile read failed; nothing cancelled this tick',
      expect.objectContaining({ locationId: LOC, err: expect.objectContaining({ code: '57014' }) }),
    )
  })

  it('a successful reconcile read reports reconcileFailed: false and cancels what Glofox dropped', async () => {
    const db = makeDb({ readResult: { data: [{ glofox_event_id: 'evt-live' }, { glofox_event_id: 'evt-gone' }], error: null } })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out).toMatchObject({ ok: true, cancelled: 1, reconcileFailed: false })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a failed cancel UPDATE is reported too (reconcileFailed), still logged at warn as before', async () => {
    const db = makeDb({
      readResult: { data: [{ glofox_event_id: 'evt-gone' }], error: null },
      updateResult: { data: null, error: { message: 'write failed' } },
    })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out).toMatchObject({ ok: true, cancelled: 0, reconcileFailed: true })
    expect(logWarn).toHaveBeenCalledWith('class-occurrences', 'cancel reconcile failed', expect.objectContaining({ locationId: LOC }))
  })

  it('a zero-event fetch does not reconcile, so it cannot fail: reconcileFailed false', async () => {
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [] })
    const out = await syncOccurrencesForLocation(makeDb(), { locationId: LOC, creds, nowMs: NOW })
    expect(out).toMatchObject({ ok: true, cancelled: 0, reconcileFailed: false })
  })
})
