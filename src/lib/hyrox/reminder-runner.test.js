// HYROX-MOBILE (Batch D) + C1 RECIPIENTS.1 — who is reminded, and that a
// failed "who" read claims nothing so the next 5-minute tick tries again.
// Before C1 the class was CLAIMED first; a failed approver read then came back
// as [] and the reminder was lost for good.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), readRoleRecipientIds: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { sendPush, readRoleRecipientIds } = await import('@/lib/push')
const { logWarn, logError } = await import('@/lib/log')
const { runHyroxClassReminder } = await import('./reminder-runner')

// 08:40 UTC; the class starts 09:00 UTC, inside the 30-minute lead.
const NOW = Date.UTC(2026, 8, 28, 8, 40)
const OCC = { name: 'HYROX Engine', starts_at: '2026-09-28T09:00:00.000Z', ends_at: '2026-09-28T10:00:00.000Z' }
// session_weekdays [] → no session row is looked up (slotFor → null).
const BLOCK = { id: 'blk-1', location_id: 'loc-1', starts_on: '2026-09-07', weeks: 8, session_weekdays: [] }

const thenable = (result) => ({ then: (res, rej) => Promise.resolve(result).then(res, rej) })
function chain(result) {
  const b = { then: (res, rej) => Promise.resolve(result).then(res, rej) }
  for (const m of ['select', 'eq', 'is', 'gte', 'lte', 'order']) b[m] = () => b
  b.maybeSingle = () => thenable({ data: null, error: null })
  return b
}

// `claimed` is the hyrox_class_reminders unique index, kept across runs so a
// test can follow one class over two ticks.
function makeDb({ onShift = [], onShiftError = null, claimed = new Set() } = {}) {
  const calls = { upserts: [], updates: [], rpc: [] }
  return {
    calls,
    claimed,
    from(table) {
      if (table === 'hyrox_blocks') return chain({ data: [BLOCK], error: null })
      if (table === 'class_occurrences') return chain({ data: [OCC], error: null })
      if (table === 'hyrox_sessions') return chain({ data: null, error: null })
      if (table === 'hyrox_class_reminders') {
        return {
          upsert: (row) => ({
            select: () => {
              calls.upserts.push(row)
              const key = `${row.location_id}|${row.class_starts_at}`
              if (claimed.has(key)) return thenable({ data: [], error: null })
              claimed.add(key)
              return thenable({ data: [{ id: `rem-${claimed.size}` }], error: null })
            },
          }),
          update: (patch) => ({ eq: (_c, id) => { calls.updates.push({ id, patch }); return thenable({ error: null }) } }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc(name, args) {
      calls.rpc.push({ name, args })
      return thenable({ data: onShiftError ? null : onShift, error: onShiftError })
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
  readRoleRecipientIds.mockResolvedValue({ ids: ['m1'], error: null })
})

describe('runHyroxClassReminder', () => {
  it('reminds the coaches on shift, once, and never reads the approver roles', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }] })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.rpc[0]).toEqual({ name: 'hyrox_coaches_on_shift', args: { p_location: 'loc-1', p_start: OCC.starts_at, p_end: OCC.ends_at } })
    expect(readRoleRecipientIds).not.toHaveBeenCalled()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['c1'])
    expect(sendPush.mock.calls[0][2]).toEqual({ locationId: 'loc-1', requireMobileKey: 'hyrox' })
    expect(db.calls.updates).toEqual([{ id: 'rem-1', patch: { session_id: null, recipient_count: 1 } }])
    expect(stats).toEqual({ classes: 1, reminded: 1, recipients: 1, recipients_failed: 0 })
  })

  it('nobody on shift: the approver roles at that studio are reminded', async () => {
    const db = makeDb()
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(readRoleRecipientIds).toHaveBeenCalledWith(db, 'loc-1', ['owner', 'manager', 'head_coach'])
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
  })

  it('a failed approver read claims NOTHING and sends nothing; the next tick sends', async () => {
    readRoleRecipientIds.mockResolvedValueOnce({ ids: [], error: { message: 'down' } })
    const db = makeDb()
    const first = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.upserts).toEqual([])
    expect(sendPush).not.toHaveBeenCalled()
    expect(first).toEqual({ classes: 1, reminded: 0, recipients: 0, recipients_failed: 1 })
    expect(logError).toHaveBeenCalledWith('hyrox-reminder', expect.stringContaining('read failed'),
      expect.objectContaining({ locationId: 'loc-1', class_starts_at: OCC.starts_at, err: 'down' }))

    // Five minutes later, still 15 minutes before the class.
    const second = await runHyroxClassReminder(db, { nowMs: NOW + 5 * 60_000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
    expect(second).toMatchObject({ reminded: 1, recipients_failed: 0 })
  })

  it('nobody at all: nothing is claimed, so a coach rostered before the class is still reminded', async () => {
    readRoleRecipientIds.mockResolvedValue({ ids: [], error: null })
    const db = makeDb()
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.upserts).toEqual([])
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('a failed on-shift read falls back to the approver roles, and says so', async () => {
    const db = makeDb({ onShiftError: { message: 'rpc down' } })
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
    expect(logWarn).toHaveBeenCalledWith('hyrox-reminder', expect.stringContaining('on-shift'),
      expect.objectContaining({ locationId: 'loc-1', err: 'rpc down' }))
  })

  it('a class already reminded is never sent twice', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], claimed: new Set([`loc-1|${OCC.starts_at}`]) })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ classes: 1, reminded: 0 })
  })
})
