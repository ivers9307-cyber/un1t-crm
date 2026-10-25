// C16 PUSHREADERR.1 — sendPush's own reads (profiles, profile_locations, the
// role templates, device_tokens) used to discard their errors, so a DB blip
// came back as { sent: 0, failed: 0 }: "nobody to tell" / "no device". Every
// send-once caller then ledgered, kept its claim or stamped, and the message
// was lost for good. A failed read is now `failed` + `read_failed: 1`, logged
// once, and the send DECISION is unchanged (D1–D4 of the plan).
//
// Own file: push.test.js's fake cannot answer an error per table.
//
// Every read gets ONE retry after READ_RETRY_DELAY_MS before it counts as
// failed, so the clock is fake here (setTimeout only) and each call is
// settled by running the timers: no real wait enters the suite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// fail[table]: every read of it fails. failOnce[table]: only the first does.
const h = vi.hoisted(() => ({ fail: {}, failOnce: {}, calls: [] }))

const PROFILES = [
  { id: 'mgr-1', active: true, employment_type: 'fte' },
  { id: 'fte-1', active: true, employment_type: 'fte' },
  { id: 'con-1', active: true, employment_type: 'contractor' },
]
const LINKS = [
  { profile_id: 'mgr-1', location_id: 'loc-1', role: 'manager', permissions: {} },
  { profile_id: 'fte-1', location_id: 'loc-1', role: 'staff', permissions: {} },
  { profile_id: 'con-1', location_id: 'loc-1', role: 'staff', permissions: {} },
]
// The live shape (prod, 28 Sep): the staff/fte template turns bookings ON; the
// staff role default is OFF (shared/permissions.js).
const TEMPLATES = [
  { location_id: 'loc-1', role: 'staff', employment_type: 'fte', permissions: { mobile: { notify_bookings: true } } },
]
const TOKENS = [
  { id: 't-mgr', user_id: 'mgr-1', expo_push_token: 'ExponentPushToken[mgr]' },
  { id: 't-fte', user_id: 'fte-1', expo_push_token: 'ExponentPushToken[fte]' },
  { id: 't-con', user_id: 'con-1', expo_push_token: 'ExponentPushToken[con]' },
]
const FIXTURES = { profiles: PROFILES, profile_locations: LINKS, location_role_permissions: TEMPLATES, device_tokens: TOKENS }
const ROLE_LINKS = [{ profile_id: 'mgr-1', role: 'manager', profiles: { id: 'mgr-1', role: 'manager', active: true } }]

function answer(table, b) {
  // The role fan-out's own read (C1) embeds profiles; it is not under test here.
  if (table === 'profile_locations' && b.sel.includes('profiles!inner')) return { data: ROLE_LINKS, error: null }
  const once = h.failOnce[table]
  if (once) {
    delete h.failOnce[table]
    if (once instanceof Error) throw once
    return { data: null, error: once }
  }
  const f = h.fail[table]
  if (f instanceof Error) throw f
  if (f) return { data: null, error: f }
  const rows = FIXTURES[table] || []
  return { data: b.inCol ? rows.filter((r) => b.inVals.includes(r[b.inCol])) : rows, error: null }
}
function fakeDb() {
  return {
    from(table) {
      const b = { table, sel: '', op: 'select', inCol: null, inVals: [] }
      b.select = (s) => { b.sel = String(s || ''); return b }
      b.in = (col, vals) => { b.inCol = col; b.inVals = vals; return b }
      b.eq = () => b
      b.not = () => b
      b.delete = () => { b.op = 'delete'; return b }
      b.then = (res, rej) => {
        h.calls.push({ table, op: b.op })
        return Promise.resolve().then(() => (b.op === 'delete' ? { error: null } : answer(table, b))).then(res, rej)
      }
      return b
    },
  }
}

vi.mock('./supabase.js', () => ({ createServerClient: () => fakeDb() }))
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError } = await import('./log.js')
const push = await import('./push.js')

const READ_ERR = { message: 'fetch failed' }
const PAYLOAD = { title: 'PT in 1 hour', body: 'Guest · 11:00', category: 'bookings', data: { type: 'booking_reminder' } }
const sentTo = () => global.fetch.mock.calls.flatMap(([, opts]) => JSON.parse(opts.body).map((m) => m.to))
const readsOf = (table) => h.calls.filter((c) => c.table === table && c.op === 'select').length
// Run the (fake) retry pauses to completion, then take the answer.
async function settle(promise) {
  await vi.runAllTimersAsync()
  return promise
}

afterEach(() => { vi.useRealTimers() })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  h.fail = {}
  h.failOnce = {}
  h.calls = []
  global.fetch = vi.fn(async (_url, opts) => ({
    ok: true,
    json: async () => ({ data: JSON.parse(opts.body).map(() => ({ status: 'ok' })) }),
  }))
})

describe('sendPush — a clean read is unchanged (control)', () => {
  it('reaches the manager and, through the staff/fte template, the FTE coach; plain counts, no read_failed', async () => {
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 2, skipped: 0, invalidated: 0, failed: 0 })
    expect(sentTo()).toEqual(['ExponentPushToken[mgr]', 'ExponentPushToken[fte]'])
    expect(logError).not.toHaveBeenCalled()
  })

  it('a genuine opt-out (contractor: role default off, no template) is skipped, not failed', async () => {
    const r = await settle(push.sendPush(['con-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 1, invalidated: 0, failed: 0 })
  })
})

describe('sendPush — the permission reads (D1, D2)', () => {
  it('a failed profiles read sends nothing and says so: every candidate failed, read_failed, one logError', async () => {
    h.fail.profiles = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 2, read_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(h.calls.some((c) => c.table === 'device_tokens')).toBe(false)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push', 'permissions read failed; nobody was told', expect.objectContaining({
      candidates: 2, category: 'bookings', type: 'booking_reminder', err: READ_ERR,
    }))
  })

  it('a failed profile_locations read sends nothing (never around an opt-out) and says so', async () => {
    h.fail.profile_locations = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'con-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 2, read_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('the reminder crons\' rule reads it as a failed send: sent 0 and failed > 0', async () => {
    h.fail.profiles = READ_ERR
    const r = await settle(push.sendPush(['mgr-1'], PAYLOAD))
    expect((r.sent || 0) === 0 && (r.failed || 0) > 0).toBe(true)
  })
})

describe('sendPush — the role templates (D3)', () => {
  it('unreadable templates: judged on code defaults as before, but a refusal on defaults is FAILED, not skipped', async () => {
    h.fail.location_role_permissions = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    // mgr-1 is allowed by default and still told; fte-1 is refused by the
    // default the template would have overridden: unjudged, so failed.
    expect(r).toEqual({ sent: 1, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })
    expect(sentTo()).toEqual(['ExponentPushToken[mgr]'])
    expect(logError).toHaveBeenCalledWith('push', 'role templates read failed; judged on code defaults', expect.objectContaining({
      candidates: 2, refused: 1, category: 'bookings', err: READ_ERR,
    }))
  })

  it('a single refused recipient under unreadable templates is a failed send, so the reminder cron retries', async () => {
    h.fail.location_role_permissions = READ_ERR
    const r = await settle(push.sendPush(['fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a template read that THROWS is treated the same way and never escapes sendPush', async () => {
    h.fail.location_role_permissions = new Error('boom')
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 1, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })
  })
})

describe('sendPush — the device read (D4)', () => {
  it('a failed device_tokens read is not "no device": every allowed candidate failed, read_failed, one logError', async () => {
    h.fail.device_tokens = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 2, read_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push', 'device_tokens read failed; nobody was told', expect.objectContaining({
      candidates: 2, category: 'bookings', err: READ_ERR,
    }))
  })

  it('a genuine opt-out in the same call is still skipped', async () => {
    h.fail.device_tokens = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'con-1'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 1, invalidated: 0, failed: 1, read_failed: 1 })
  })

  it('the role fan-out passes it through unchanged', async () => {
    h.fail.device_tokens = READ_ERR
    const r = await settle(push.sendPushToRolesAtLocation('loc-1', ['manager'], PAYLOAD))
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })
  })
})

describe('sendPush — one in-process retry of a failed read (review)', () => {
  const READS = ['profiles', 'profile_locations', 'location_role_permissions', 'device_tokens']

  it.each(READS)('a %s read that fails once and then succeeds is a normal send: no read_failed, no logError', async (table) => {
    h.failOnce[table] = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 2, skipped: 0, invalidated: 0, failed: 0 })
    expect(sentTo()).toEqual(['ExponentPushToken[mgr]', 'ExponentPushToken[fte]'])
    expect(readsOf(table)).toBe(2)
    // Only the read is retried, never the send.
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(logError).not.toHaveBeenCalled()
  })

  it('a template read that THROWS once is retried the same way', async () => {
    h.failOnce.location_role_permissions = new Error('boom')
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r).toEqual({ sent: 2, skipped: 0, invalidated: 0, failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  it.each(READS)('a %s read that fails twice is read exactly twice, then a read failure logged once', async (table) => {
    h.fail[table] = READ_ERR
    const r = await settle(push.sendPush(['mgr-1', 'fte-1'], PAYLOAD))
    expect(r.read_failed).toBe(1)
    expect(r.failed).toBeGreaterThan(0)
    expect(readsOf(table)).toBe(2)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a failed profiles read stops there: profile_locations is never read', async () => {
    h.fail.profiles = READ_ERR
    await settle(push.sendPush(['mgr-1'], PAYLOAD))
    expect(readsOf('profiles')).toBe(2)
    expect(readsOf('profile_locations')).toBe(0)
  })

  it('the retry waits READ_RETRY_DELAY_MS (200 ms) by default, on the fake clock', async () => {
    h.failOnce.device_tokens = READ_ERR
    const p = push.sendPush(['mgr-1'], PAYLOAD)
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('device_tokens')).toBe(1)
    await vi.advanceTimersByTimeAsync(199)
    expect(readsOf('device_tokens')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf('device_tokens')).toBe(2)
    expect(await settle(p)).toEqual({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
  })

  it('readRetryDelayMs: 0 retries with no pause at all (no timer is scheduled)', async () => {
    h.failOnce.device_tokens = READ_ERR
    h.failOnce.profiles = READ_ERR
    const r = await push.sendPush(['mgr-1'], PAYLOAD, { readRetryDelayMs: 0 })
    expect(r).toEqual({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('readPushAllowedIds on its own retries too (the notify fallback calls it directly)', async () => {
    h.failOnce.profile_locations = READ_ERR
    const r = await push.readPushAllowedIds(fakeDb(), ['mgr-1', 'fte-1', 'con-1'], 'bookings', { readRetryDelayMs: 0 })
    expect([...r.allowed].sort()).toEqual(['fte-1', 'mgr-1'])
    expect(r.error).toBeNull()
    expect(r.templatesError).toBeNull()
  })
})

describe('readPushAllowedIds / resolvePushAllowedIds (D5)', () => {
  it('readPushAllowedIds returns the allowed set with the read errors beside it', async () => {
    const ok = await settle(push.readPushAllowedIds(fakeDb(), ['mgr-1', 'fte-1', 'con-1'], 'bookings'))
    expect([...ok.allowed].sort()).toEqual(['fte-1', 'mgr-1'])
    expect(ok.error).toBeNull()
    expect(ok.templatesError).toBeNull()

    h.fail.profiles = READ_ERR
    const bad = await settle(push.readPushAllowedIds(fakeDb(), ['mgr-1'], 'bookings'))
    expect(bad.allowed.size).toBe(0)
    expect(bad.error).toBe(READ_ERR)
  })

  it('resolvePushAllowedIds keeps its old contract (a Set; empty on a failed read)', async () => {
    h.fail.profiles = READ_ERR
    const allowed = await settle(push.resolvePushAllowedIds(fakeDb(), ['mgr-1'], 'bookings'))
    expect(allowed).toBeInstanceOf(Set)
    expect(allowed.size).toBe(0)
  })
})
