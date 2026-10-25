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
// `existsError` makes the cheap "already reminded?" read fail.
function makeDb({ onShift = [], onShiftError = null, claimed = new Set(), existsError = null, deleteError = null, upsertError = null, updateError = null } = {}) {
  const calls = { upserts: [], updates: [], rpc: [], existsReads: [], deletes: [] }
  const idToKey = new Map()
  return {
    calls,
    claimed,
    from(table) {
      if (table === 'hyrox_blocks') return chain({ data: [BLOCK], error: null })
      if (table === 'class_occurrences') return chain({ data: [OCC], error: null })
      if (table === 'hyrox_sessions') return chain({ data: null, error: null })
      if (table === 'hyrox_class_reminders') {
        return {
          select: (cols) => {
            const filters = {}
            const q = {
              eq: (col, val) => { filters[col] = val; return q },
              maybeSingle: () => {
                calls.existsReads.push({ cols, filters: { ...filters } })
                if (existsError) return thenable({ data: null, error: existsError })
                const key = `${filters.location_id}|${filters.class_starts_at}`
                return thenable({ data: claimed.has(key) ? { id: 'rem-old' } : null, error: null })
              },
            }
            return q
          },
          upsert: (row) => ({
            select: () => {
              calls.upserts.push(row)
              if (upsertError) return thenable({ data: null, error: upsertError })
              const key = `${row.location_id}|${row.class_starts_at}`
              if (claimed.has(key)) return thenable({ data: [], error: null })
              claimed.add(key)
              const id = `rem-${claimed.size}`
              idToKey.set(id, key)
              return thenable({ data: [{ id }], error: null })
            },
          }),
          update: (patch) => ({ eq: (_c, id) => { calls.updates.push({ id, patch }); return thenable({ error: updateError }) } }),
          delete: () => ({
            eq: (_c, id) => {
              calls.deletes.push(id)
              if (deleteError) return thenable({ error: deleteError })
              claimed.delete(idToKey.get(id))
              return thenable({ error: null })
            },
          }),
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
    expect(stats).toEqual({ classes: 1, reminded: 1, recipients: 1, recipients_failed: 0, send_failed: 0, claim_failed: 0 })
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
    expect(first).toEqual({ classes: 1, reminded: 0, recipients: 0, recipients_failed: 1, send_failed: 0, claim_failed: 0 })
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

  // A class already claimed is skipped BEFORE its recipients are read, so a
  // transient recipients-read failure on a later tick cannot raise a false
  // "nothing claimed, the next tick retries" for a class that was reminded.
  it('an already-reminded class reads no recipients, logs nothing, sends nothing', async () => {
    readRoleRecipientIds.mockResolvedValue({ ids: [], error: { message: 'down' } })
    const db = makeDb({ claimed: new Set([`loc-1|${OCC.starts_at}`]) })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.existsReads).toEqual([{ cols: 'id', filters: { location_id: 'loc-1', class_starts_at: OCC.starts_at } }])
    expect(db.calls.rpc).toEqual([])
    expect(readRoleRecipientIds).not.toHaveBeenCalled()
    expect(db.calls.upserts).toEqual([])
    expect(logError).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
    expect(stats).toEqual({ classes: 1, reminded: 0, recipients: 0, recipients_failed: 0, send_failed: 0, claim_failed: 0 })
  })

  // The existence read is only an early-out; the ON CONFLICT claim stays the
  // real guard. A failed existence read must not fail louder than main did.
  it('a failed existence read falls through: recipients read, claimed, sent once', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], existsError: { message: 'blip' } })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.rpc).toHaveLength(1)
    expect(db.calls.upserts).toHaveLength(1)
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['c1'])
    expect(logError).not.toHaveBeenCalled()
    expect(stats).toEqual({ classes: 1, reminded: 1, recipients: 1, recipients_failed: 0, send_failed: 0, claim_failed: 0 })
  })

  it('a failed existence read on an already-claimed class still never sends twice', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], existsError: { message: 'blip' },
      claimed: new Set([`loc-1|${OCC.starts_at}`]) })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ reminded: 0 })
  })
})

// C16 PUSHREADERR.1 — the class is claimed BEFORE the send, and the send's
// result was ignored: a failed read inside sendPush (or an Expo failure) lost
// the reminder for good. Nothing delivered + something failed now releases
// the claim, so the next 5-minute tick, still inside the 30-minute lead,
// sends it. Anything delivered keeps it.
describe('runHyroxClassReminder — a send that reached nobody because something failed (C16 PUSHREADERR.1)', () => {
  const READ_FAILED = { sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 }

  it('releases the claim, counts send_failed, skips the bookkeeping; the next tick sends', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }] })
    sendPush.mockResolvedValueOnce(READ_FAILED)
    const first = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.deletes).toEqual(['rem-1'])
    expect(db.claimed.size).toBe(0)
    expect(db.calls.updates).toEqual([])
    expect(first).toEqual({ classes: 1, reminded: 0, recipients: 0, recipients_failed: 0, send_failed: 1, claim_failed: 0 })
    expect(logWarn).toHaveBeenCalledWith('hyrox-reminder', 'nothing delivered; claim released, the next tick retries',
      expect.objectContaining({ locationId: 'loc-1', class_starts_at: OCC.starts_at, read_failed: true }))

    const second = await runHyroxClassReminder(db, { nowMs: NOW + 5 * 60_000 })
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(second).toMatchObject({ reminded: 1, send_failed: 0 })
    expect(db.claimed.size).toBe(1)
  })

  it('a delivered send keeps the claim even when something else failed (never a duplicate)', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }, { profile_id: 'c2' }] })
    sendPush.mockResolvedValueOnce({ sent: 1, skipped: 0, invalidated: 0, failed: 1 })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.deletes).toEqual([])
    expect(stats).toMatchObject({ reminded: 1, send_failed: 0 })
  })

  it('nobody with a device (sent 0, failed 0) keeps the claim, as before', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }] })
    sendPush.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.deletes).toEqual([])
    expect(db.claimed.size).toBe(1)
  })

  it('a failed release is said at error level: this class will not be reminded', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], deleteError: { message: 'down' } })
    sendPush.mockResolvedValueOnce(READ_FAILED)
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(stats.send_failed).toBe(1)
    expect(logError).toHaveBeenCalledWith('hyrox-reminder', 'nothing delivered and the claim release failed; this class will not be reminded',
      expect.objectContaining({ locationId: 'loc-1', err: 'down' }))
  })

  // C21 PUSHDONE.1 (F3) — a failed claim write read as "already claimed".
  it('a failed claim write sends nothing, is counted and said, and the next tick claims and sends', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], upsertError: { message: 'down' } })
    const first = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush).not.toHaveBeenCalled()
    expect(first).toMatchObject({ reminded: 0, claim_failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('hyrox-reminder', 'claim write failed; nothing sent, the next tick retries',
      { locationId: 'loc-1', class_starts_at: OCC.starts_at, err: 'down' })

    const healthy = makeDb({ onShift: [{ profile_id: 'c1' }], claimed: db.claimed })
    const second = await runHyroxClassReminder(healthy, { nowMs: NOW + 5 * 60_000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ reminded: 1, claim_failed: 0 })
  })

  it('a lost bookkeeping write is said, and the reminder still counts as sent', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], updateError: { message: 'down' } })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(stats).toMatchObject({ reminded: 1 })
    expect(logWarn).toHaveBeenCalledWith('hyrox-reminder', 'reminder bookkeeping write failed; the reminder was sent', { reminderId: 'rem-1', err: 'down' })
  })
})
