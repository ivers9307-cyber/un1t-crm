// SEQTASK.1 (October audit A12) — a sequence "create task" step writes the
// columns the Tasks board reads, and a rejected insert never completes the step.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { internalTaskStep } = await import('./steps.js')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { logWarn } = await import('@/lib/log')

function makeDb({ member = { profile_id: 'u1' }, memberErr = null, insertErr = null, zoneErr = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [], payload: null }
      calls.push(q)
      const answer = () => {
        if (table === 'locations') return zoneErr ? { data: null, error: zoneErr } : { data: { id: 'loc-1', timezone: 'Europe/Dublin' }, error: null }
        if (table === 'profile_locations') return { data: memberErr ? null : member, error: memberErr }
        if (table === 'activities') return { data: null, error: insertErr }
        return { data: null, error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'limit']) b[m] = (...a) => { q.ops.push([m, ...a]); return b }
      b.insert = (p) => { q.payload = p; return b }
      b.maybeSingle = () => Promise.resolve(answer())
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}
const insertOf = (db) => db.calls.find((c) => c.table === 'activities').payload
const STEP = { id: 'st-1', config: { subject: 'Call them', note: 'Ask about the trial', assignee_user_id: 'u1', due_offset_minutes: 90 } }
const CONTACT = { id: 'c1', location_id: 'loc-other' }
const SEQUENCE = { id: 'seq-1', location_id: 'loc-1' }

beforeEach(() => {
  vi.clearAllMocks()
  resetLocationZoneCache('loc-1')
  vi.useFakeTimers()
  // 15 Nov 2026 13:00 UTC = 13:00 in Dublin (winter time).
  vi.setSystemTime(new Date('2026-11-15T13:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('internalTaskStep', () => {
  it("writes a task on the board's columns, due on the studio's clock", async () => {
    const db = makeDb()
    await internalTaskStep(db, { step: STEP, contact: CONTACT, sequence: SEQUENCE })
    expect(insertOf(db)).toEqual({
      contact_id: 'c1', location_id: 'loc-1', type: 'task', kind: 'task', status: 'todo', source: 'crm',
      subject: 'Call them', note: 'Ask about the trial', assignee_id: 'u1', due_date: '2026-11-15', due_time: '14:30',
    })
  })

  it('a blank due offset files the task with no due date', async () => {
    const db = makeDb()
    await internalTaskStep(db, { step: { ...STEP, config: { ...STEP.config, due_offset_minutes: null } }, contact: CONTACT, sequence: SEQUENCE })
    expect(insertOf(db)).toMatchObject({ due_date: null, due_time: null })
    expect(db.calls.some((c) => c.table === 'locations')).toBe(false)
  })

  it('an assignee who does not work at the studio is dropped, the task still filed', async () => {
    const db = makeDb({ member: null })
    await internalTaskStep(db, { step: STEP, contact: CONTACT, sequence: SEQUENCE })
    expect(insertOf(db).assignee_id).toBeNull()
    expect(logWarn).toHaveBeenCalled()
    const check = db.calls.find((c) => c.table === 'profile_locations')
    expect(check.ops).toContainEqual(['eq', 'location_id', 'loc-1'])
  })

  it('a rejected insert throws, so the step does not complete', async () => {
    const db = makeDb({ insertErr: { message: 'column "x" does not exist' } })
    await expect(internalTaskStep(db, { step: STEP, contact: CONTACT, sequence: SEQUENCE })).rejects.toThrow(/task insert failed/)
  })

  it('a failed assignee or zone read throws rather than guessing', async () => {
    await expect(internalTaskStep(makeDb({ memberErr: { message: 'down' } }), { step: STEP, contact: CONTACT, sequence: SEQUENCE })).rejects.toThrow(/assignee/)
    resetLocationZoneCache('loc-1')
    await expect(internalTaskStep(makeDb({ zoneErr: { message: 'down' } }), { step: STEP, contact: CONTACT, sequence: SEQUENCE })).rejects.toThrow()
  })

  it('a step with no subject still refuses', async () => {
    await expect(internalTaskStep(makeDb(), { step: { config: {} }, contact: CONTACT, sequence: SEQUENCE })).rejects.toThrow(/subject/)
  })
})
