// C21 PUSHDONE.1 — a contract reminder is recorded (last_reminded_at +
// reminder_count) only when it reached the person, or when nothing transient
// stands between them and it. It used to be recorded whatever the email and
// the push did, so a reminder nobody received counted as reminder N.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updates = []
let contractRows = []
function makeBuilder(table) {
  const state = {}
  const b = {}
  for (const m of ['select', 'in', 'lt', 'order', 'range', 'eq']) b[m] = () => b
  b.update = (patch) => { state.patch = patch; updates.push({ table, patch }); return b }
  b.then = (resolve, reject) => Promise.resolve(state.patch ? { data: null, error: null } : { data: contractRows, error: null }).then(resolve, reject)
  return b
}
const fakeDb = { from: (t) => makeBuilder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => true) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn() }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn(async () => ({})) }))
vi.mock('@/lib/qualification-digest', () => ({ runQualificationDigest: vi.fn(async () => ({})) }))

const { GET } = await import('./route.js')
const { sendContractReminderEmail } = await import('@/lib/contracts-email')
const { sendPush } = await import('@/lib/push')
const { logWarn } = await import('@/lib/log')

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const CONTRACT = { id: 'k1', status: 'issued', issued_at: '2026-09-20T09:00:00Z', reminder_count: 0, profile: { id: 'p1', full_name: 'Test Coach', email: 'coach@example.test' }, template: { name: 'Coach agreement' } }
const stamped = () => updates.filter((u) => u.table === 'contracts' && u.patch.reminder_count === 1)

const PUSH_DELIVERED = { sent: 1, skipped: 0, invalidated: 0, failed: 0 }
const PUSH_FAILED = { sent: 0, skipped: 0, invalidated: 0, failed: 1 }
const PUSH_NO_DEVICE = { sent: 0, skipped: 0, invalidated: 0, failed: 0 }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  updates.length = 0
  contractRows = [CONTRACT]
})

describe('contract-reminders — record the reminder only when it went out (C21 PUSHDONE.1)', () => {
  it('email delivered: recorded, whatever the push did (a retry would repeat the email)', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: true })
    sendPush.mockResolvedValue(PUSH_FAILED)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(1)
    expect(body).toMatchObject({ sent: 1, undelivered: 0 })
  })

  it('email failed but the push landed: recorded', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'Postmark send failed' })
    sendPush.mockResolvedValue(PUSH_DELIVERED)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(1)
    expect(body).toMatchObject({ sent: 1, emailFailed: 1, undelivered: 0 })
  })

  it('email failed (transient) and no device: NOT recorded, tomorrow retries', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'Postmark send failed' })
    sendPush.mockResolvedValue(PUSH_NO_DEVICE)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(0)
    expect(body).toMatchObject({ sent: 0, emailFailed: 1, undelivered: 1 })
    expect(logWarn).toHaveBeenCalledWith('cron-contract-reminders', 'reminder reached nobody; not recorded, tomorrow retries',
      { contract_id: 'k1', email_error: 'Postmark send failed', push: 'settled' })
  })

  it('no email address and the push FAILED: NOT recorded (the push can succeed tomorrow)', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'No recipient email', permanent: true })
    sendPush.mockResolvedValue(PUSH_FAILED)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(0)
    expect(body.undelivered).toBe(1)
  })

  it('a throwing push counts as failed', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'No recipient email', permanent: true })
    sendPush.mockRejectedValue(new Error('boom'))
    await GET(req())
    expect(stamped()).toHaveLength(0)
    expect(logWarn).toHaveBeenCalledWith('cron-contract-reminders', 'reminder push threw', { contract_id: 'k1', err: 'boom' })
  })

  // PUSHDONE.1a — a hard-bounced address (Postmark 406 / 300, mapped to
  // permanent by sendContractReminderEmail) is recorded like a missing one,
  // so the contract reaches the normal 2-reminder cap instead of being
  // retried every day forever.
  it('email hard-bounced (permanent) and no device: recorded, counts toward the cap', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'recipient marked as inactive', permanent: true })
    sendPush.mockResolvedValue(PUSH_NO_DEVICE)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(1)
    expect(body).toMatchObject({ sent: 1, emailFailed: 1, undelivered: 0 })
  })

  it('email hard-bounced (permanent) but the push FAILED: NOT recorded (the push can land tomorrow)', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'recipient marked as inactive', permanent: true })
    sendPush.mockResolvedValue(PUSH_FAILED)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(0)
    expect(body.undelivered).toBe(1)
  })

  it('no email address and no device: recorded — nothing to retry against', async () => {
    sendContractReminderEmail.mockResolvedValue({ ok: false, error: 'No recipient email', permanent: true })
    sendPush.mockResolvedValue(PUSH_NO_DEVICE)
    const body = await (await GET(req())).json()
    expect(stamped()).toHaveLength(1)
    expect(body.undelivered).toBe(0)
  })
})
