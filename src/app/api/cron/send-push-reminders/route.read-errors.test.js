// CRONREADERR.1 — the push-reminder cron's task and booking arms, when a read
// fails. Its own file: route.test.js is C5's (REPLACENITS.1) hunk, and its
// fake cannot answer per-table or maybeSingle/insert.
//
// The fake answers per table; profile_locations is told apart by its select
// (the booking arm embeds profiles!inner). The clock is fixed at 10:00 Dublin
// (IST) on 6 Oct 2026, and the studio's lead time for both kinds is 60 min.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const NOW = Date.parse('2026-10-06T09:00:00.000Z') // 10:00 Europe/Dublin
const LOCATIONS = [{
  id: 'loc-1', name: 'Studio', timezone: 'Europe/Dublin',
  notification_config: { categories: { tasks: { lead_times_minutes: [60] }, bookings: { lead_times_minutes: [60], notify_roles: ['manager'] } } },
}]
const READ_ERR = { message: 'fetch failed' }
const MANAGER_LINK = { profile_id: 'mgr-1', location_id: 'loc-1', permissions: {}, profiles: { id: 'mgr-1', role: 'manager', active: true } }

const state = {}
function resetState() {
  Object.assign(state, {
    tasks: [],
    bookings: [],
    taskPerms: { data: [], error: null },
    bookingLinks: { data: [MANAGER_LINK], error: null },
    dedup: { data: null, error: null },
    insertResult: { data: null, error: null },
    inserts: [],
  })
}
function resultFor(table, b) {
  if (table === 'locations') return { data: LOCATIONS, error: null }
  if (table === 'activities') return { data: state.tasks, error: null }
  if (table === 'bookings') return { data: state.bookings, error: null }
  if (table === 'profile_locations') return b.sel.includes('profiles!inner') ? state.bookingLinks : state.taskPerms
  if (table === 'push_reminder_sends') return b.op === 'insert' ? state.insertResult : state.dedup
  return { data: [], error: null }
}
function makeBuilder(table) {
  const b = { op: 'select', sel: '' }
  for (const m of ['eq', 'in', 'not', 'gte', 'lte', 'order', 'range', 'maybeSingle']) b[m] = () => b
  b.select = (s) => { b.sel = String(s || ''); return b }
  b.insert = (row) => { b.op = 'insert'; state.inserts.push({ table, row }); return b }
  b.then = (resolve, reject) => Promise.resolve(resultFor(table, b)).then(resolve, reject)
  return b
}
const fakeDb = { from: (t) => makeBuilder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/shift-reminders', () => ({ runShiftReminders: vi.fn(async () => ({})) }))
vi.mock('@/lib/shift-replace-notify', () => ({ runReplaceNotices: vi.fn() }))
vi.mock('@/lib/block-edit-notify', () => ({ runShiftTimeChangeNotices: vi.fn(async () => ({})) }))
vi.mock('@/lib/shift-offer-server', () => ({ runShiftOfferSweep: vi.fn() }))

import { GET } from './route.js'
import { sendPush } from '@/lib/push'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo, logWarn } from '@/lib/log'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
// A task due at `hhmm` Dublin today; at 10:00, '11:00' is 60 min away (delta 0),
// '10:58' is 58 (delta -2: a later tick can still fire it), '10:47' is 47
// (delta -13: the last tick that can).
const task = (hhmm) => ({ id: 'task-1', subject: 'Call back', assignee_id: 'coach-1', location_id: 'loc-1', due_date: '2026-10-06', due_time: `${hhmm}:00` })
const booking = (hhmm) => ({ id: 'bk-1', customer_name: 'Guest', booking_date: '2026-10-06', start_time: `${hhmm}:00`, status: 'confirmed', location_id: 'loc-1', skip_reminder: false, event_type: { name: 'PT' } })
const ledgerRows = () => state.inserts.filter((i) => i.table === 'push_reminder_sends')

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  resetState()
  sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
})
afterEach(() => { vi.useRealTimers() })

describe('send-push-reminders — the task arm when a read fails (CRONREADERR.1)', () => {
  it('the cron runs every 5 minutes, which the hold-or-send rule assumes', () => {
    const vercel = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../../vercel.json'), 'utf8'))
    const entry = vercel.crons.find((c) => c.path === '/api/cron/send-push-reminders')
    expect(entry.schedule).toBe('*/5 * * * *')
  })

  it('a failed "already sent?" read with a later tick still to come HOLDS the reminder: nothing sent, no ledger row', async () => {
    state.tasks = [task('10:58')]
    state.dedup = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(ledgerRows()).toHaveLength(0)
    expect(body).toMatchObject({ ok: true, task_candidates: 1, task_dedup_unreadable: 1, task_sent_unchecked: 0, task_pushed: 0 })
    expect(logError).toHaveBeenCalledWith(
      'cron-push-reminders', 'task dedup read failed; held for the next tick',
      expect.objectContaining({ err: READ_ERR, t: 'task-1', lead: 60 }),
    )
    expect(logInfo).toHaveBeenCalledWith('cron-push-reminders', 'tick', expect.objectContaining({ task_dedup_unreadable: 1 }))
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders') // the parent still means "the tick ran"
  })

  it('on the LAST tick that can fire it, a failed dedup read sends anyway, and says so', async () => {
    state.tasks = [task('10:47')]
    state.dedup = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush).toHaveBeenCalledWith(['coach-1'], expect.objectContaining({ category: 'tasks' }))
    expect(ledgerRows()).toHaveLength(1)
    expect(body).toMatchObject({ task_dedup_unreadable: 0, task_sent_unchecked: 1, task_pushed: 1 })
    expect(logError).toHaveBeenCalledWith(
      'cron-push-reminders', 'task dedup read failed on the last tick; sending unchecked',
      expect.objectContaining({ t: 'task-1', lead: 60 }),
    )
  })

  it('an unchecked send that the ledger then refuses (23505) is recorded as the duplicate it was', async () => {
    state.tasks = [task('10:47')]
    state.dedup = { data: null, error: READ_ERR }
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } }
    await GET(req())
    expect(logWarn).toHaveBeenCalledWith('cron-push-reminders', 'unchecked task reminder was a duplicate', expect.objectContaining({ t: 'task-1', lead: 60 }))
  })

  it('a successful dedup read that finds the row still skips it (unchanged)', async () => {
    state.tasks = [task('11:00')]
    state.dedup = { data: { id: 'sent-1' }, error: null }
    const body = await (await GET(req())).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(body).toMatchObject({ task_skipped_dup: 1, task_dedup_unreadable: 0, task_sent_unchecked: 0, task_perms_read_failed: 0 })
  })

  it('a failed permissions read still sends at the studio lead time, logged and counted', async () => {
    state.tasks = [task('11:00')]
    state.taskPerms = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ task_perms_read_failed: 1, task_pushed: 1 })
    expect(logError).toHaveBeenCalledWith(
      'cron-push-reminders', 'task permissions read failed; using studio lead times',
      expect.objectContaining({ err: READ_ERR }),
    )
  })
})

describe('send-push-reminders — the booking arm when a read fails (CRONREADERR.1)', () => {
  it('a failed recipients read sends nothing this tick, writes no ledger row, and says so', async () => {
    state.bookings = [booking('11:00')]
    state.bookingLinks = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(ledgerRows()).toHaveLength(0)
    expect(body).toMatchObject({ ok: true, booking_recipients_read_failed: 1, booking_pushed: 0 })
    expect(logError).toHaveBeenCalledWith(
      'cron-push-reminders', 'booking recipients read failed; no booking reminder this tick (retried next tick)',
      expect.objectContaining({ err: READ_ERR }),
    )
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
  })

  it('a failed "already sent?" read with a later tick still to come HOLDS the booking reminder', async () => {
    state.bookings = [booking('10:58')]
    state.dedup = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(ledgerRows()).toHaveLength(0)
    expect(body).toMatchObject({ booking_candidates: 1, booking_dedup_unreadable: 1, booking_sent_unchecked: 0 })
    expect(logError).toHaveBeenCalledWith(
      'cron-push-reminders', 'booking dedup read failed; held for the next tick',
      expect.objectContaining({ err: READ_ERR, b: 'bk-1', recipient: 'mgr-1', lead: 60 }),
    )
  })

  it('on the LAST tick, a failed dedup read sends the booking reminder anyway', async () => {
    state.bookings = [booking('10:47')]
    state.dedup = { data: null, error: READ_ERR }
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledWith(['mgr-1'], expect.objectContaining({ category: 'bookings' }))
    expect(ledgerRows()).toHaveLength(1)
    expect(body).toMatchObject({ booking_dedup_unreadable: 0, booking_sent_unchecked: 1, booking_pushed: 1 })
  })

  it('a clean booking tick sends once and reports the new counters as 0 (unchanged behaviour)', async () => {
    state.bookings = [booking('11:00')]
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ booking_pushed: 1, booking_recipients_read_failed: 0, booking_dedup_unreadable: 0, booking_sent_unchecked: 0 })
  })
})

// C16 PUSHREADERR.1 — the row's named loss. sendPush used to answer a failed
// read with { sent: 0, failed: 0 }, which this cron reads as "nothing to send"
// and LEDGERS, so the reminder never went. It now answers failed > 0 +
// read_failed, which the cron's existing sendFailed branch skips the ledger on,
// so the next tick retries. Pins: these pass on main; the failing-on-main half
// is src/lib/push-read-errors.test.js.
describe('send-push-reminders — a failed read inside sendPush is a failed send (C16 PUSHREADERR.1)', () => {
  const READ_FAILED = { sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 }

  it('task: no ledger row on the failed tick; the next tick sends and ledgers', async () => {
    state.tasks = [task('11:00')]
    sendPush.mockResolvedValueOnce(READ_FAILED)
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(ledgerRows()).toHaveLength(0)
    expect(body).toMatchObject({ task_send_failed: 1, task_pushed: 0 })

    sendPush.mockResolvedValueOnce({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
    await GET(req())
    expect(ledgerRows()).toHaveLength(1)
  })

  it('booking: the same', async () => {
    state.bookings = [booking('11:00')]
    sendPush.mockResolvedValueOnce(READ_FAILED)
    const body = await (await GET(req())).json()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(ledgerRows()).toHaveLength(0)
    expect(body).toMatchObject({ booking_send_failed: 1, booking_pushed: 0 })
  })
})
