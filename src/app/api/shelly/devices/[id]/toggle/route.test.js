// SHELLY-UI.5 — the manual toggle.
//
// The four properties this suite exists for, in the order they matter:
//
//  1. THE OVERRIDE IS ON THE ROW BEFORE THE COMMAND IS SENT. Asserted from
//     INSIDE the setSwitch stub — it reads the fake's row store at the moment
//     of the call — so a refactor that sends first and records after fails
//     here rather than in production, where a briefly-offline plug would stay
//     wrong until a human noticed.
//  2. A FAILED COMMAND IS NOT A FAILED REQUEST, AND A FAILED STAMP IS NOT A
//     FAILED SWITCH. Offline/auth/rate-limited answer `pending:true` with the
//     override still written; a lost stamp still answers `applied:true`,
//     because the relay moved.
//  3. THE DEFAULT EXPIRY IS THE LOCATION'S MIDNIGHT. Computed here with
//     nextLocalMidnightMs so the assertion holds under any TZ the suite runs
//     in, and asserted to DIFFER from the Dublin answer so "it used the
//     location's zone" is actually proven.
//  4. 'auto' CLEARS FIRST, THEN RUNS — with a connection carrying the
//     location's zone, because loadConnectionWithKey does not embed one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/shelly/client', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, createShellyClient: vi.fn() }
})
vi.mock('@/lib/shelly/reconcile', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runNowForDevice: vi.fn() }
})

import { POST, HOLDS_NOTICE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import { runNowForDevice } from '@/lib/shelly/reconcile'
import { logWarn } from '@/lib/log'
import { overrideKey } from '@/lib/shelly/plan'
import { AUTH_ERROR } from '@/lib/shelly/connections'
import { MAX_OVERRIDE_HOURS } from '@/lib/shelly/schemas'
import { nextLocalMidnightMs } from '@/lib/tz-time'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, BAD_ID, OWNER_ID, OWNER_A, OWNER_NY, STAFF_A, SHELLY_ID, STORED_KEY,
  deviceRow, connectionRow, fullState, makeDb, updatesTo, jsonReq, ctxFor,
} from '../../../shelly-routes.test-helpers.js'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const HOUR = 60 * 60 * 1000

const toggleReq = (body) => jsonReq(body, 'http://localhost/api/shelly/devices/x/toggle')

const world = (over = {}, connOver = null) => ({
  rows: {
    shelly_devices: [
      deviceRow(over),
      deviceRow({ id: DEV_B, location_id: LOC_B, name: 'Their plug', device_id: 'ffeedd998877' }),
    ],
    shelly_connections: connOver === null ? [connectionRow()] : connOver,
  },
})

let db
let setSwitch
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
function useCloud(result = { ok: true, statusCode: 200 }) {
  setSwitch = vi.fn().mockResolvedValue(result)
  createShellyClient.mockReturnValue({ setSwitch })
  return setSwitch
}
const rowA = () => db.rowsIn('shelly_devices').find((r) => r.id === DEV_A)
const deviceWrites = () => updatesTo(db, 'shelly_devices')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  useDb(world())
  useCloud()
  runNowForDevice.mockResolvedValue({ ok: true, noop: true })
  getCurrentUser.mockResolvedValue(OWNER_A)
})

afterEach(() => vi.useRealTimers())

describe('POST …/toggle — the gates', () => {
  it('404s a malformed id and a foreign id identically, touching nothing', async () => {
    const malformed = await POST(toggleReq({ state: 'on' }), ctxFor(BAD_ID))
    const foreign = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_B))
    expect(malformed.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await malformed.json()).toEqual(await foreign.json())
    expect(deviceWrites()).toEqual([])
    expect(setSwitch).not.toHaveBeenCalled()
  })

  it('409s not_connected before any cloud call', async () => {
    useDb(world({}, []))
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(createShellyClient).not.toHaveBeenCalled()
    expect(deviceWrites()).toEqual([])
  })

  it('500s a FAILED connection read — that is not "not connected"', async () => {
    useDb({ ...world(), selectError: { shelly_connections: { message: 'db down' } } })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBeUndefined()
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).status).toBe(403)
    expect(deviceWrites()).toEqual([])
  })

  it('400s a state that is not on/off/auto', async () => {
    expect((await POST(toggleReq({ state: 'ON' }), ctxFor(DEV_A))).status).toBe(400)
    expect(deviceWrites()).toEqual([])
  })
})

describe('POST …/toggle — when the override expires', () => {
  it('defaults to the LOCATION’s next local midnight, not Dublin’s', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))

    const expected = new Date(nextLocalMidnightMs(NOW, 'America/New_York')).toISOString()
    const dublin = new Date(nextLocalMidnightMs(NOW, 'Europe/Dublin')).toISOString()
    expect(rowA().override.until).toBe(expected)
    // The two zones genuinely disagree at this instant, so the assertion above
    // is about the zone and not about the clock.
    expect(expected).not.toBe(dublin)
  })

  it('…and to Dublin’s for a Dublin location', async () => {
    await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(rowA().override.until).toBe(new Date(nextLocalMidnightMs(NOW, 'Europe/Dublin')).toISOString())
  })

  it('accepts an explicit until and normalises an offset form to UTC', async () => {
    await POST(toggleReq({ state: 'off', until: '2026-08-23T18:00:00+01:00' }), ctxFor(DEV_A))
    expect(rowA().override.until).toBe('2026-08-23T17:00:00.000Z')
  })

  it('400s an until that has already passed, before any write or command', async () => {
    const res = await POST(toggleReq({ state: 'on', until: '2026-08-23T11:00:00.000Z' }), ctxFor(DEV_A))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That time has already passed')
    expect(deviceWrites()).toEqual([])
    expect(setSwitch).not.toHaveBeenCalled()
  })

  it(`400s an until more than ${MAX_OVERRIDE_HOURS} hours out`, async () => {
    const res = await POST(toggleReq({ state: 'on', until: new Date(NOW + 49 * HOUR).toISOString() }), ctxFor(DEV_A))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(`An override can last at most ${MAX_OVERRIDE_HOURS} hours`)
    expect(deviceWrites()).toEqual([])
  })

  it('accepts exactly the cap', async () => {
    const res = await POST(toggleReq({ state: 'on', until: new Date(NOW + MAX_OVERRIDE_HOURS * HOUR).toISOString() }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
  })
})

describe('POST …/toggle — intent before command', () => {
  it('the override is ON THE ROW by the time setSwitch is called', async () => {
    let seen
    setSwitch = vi.fn().mockImplementation(async () => {
      seen = JSON.parse(JSON.stringify(rowA().override))
      return { ok: true, statusCode: 200 }
    })
    createShellyClient.mockReturnValue({ setSwitch })

    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    expect(seen).toMatchObject({ state: 'on', set_by: OWNER_ID, set_at: NOW_ISO })
    expect(seen.until).toEqual(expect.any(String))
    // set_at IS the exactly-once key — an override without it collides with
    // the previous one and never fires (plan.js edge a).
    expect(seen.set_at).toBeTruthy()
  })

  it('sends the STORED device id and channel, with the right on/off', async () => {
    useDb(world({ channel: 2 }))
    await POST(toggleReq({ state: 'off' }), ctxFor(DEV_A))
    expect(setSwitch).toHaveBeenCalledWith(SHELLY_ID, 2, false)
  })

  it('pins the location on the override write', async () => {
    await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(deviceWrites()[0].filters).toEqual({ id: DEV_A, location_id: LOC_A })
  })

  it('REFUSES when the override write fails — nothing is sent', async () => {
    useDb(world())
    db.conf.updateError.shelly_devices = (st) => (st.payload.override ? { message: 'db down' } : null)
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/nothing was switched/i)
    expect(setSwitch).not.toHaveBeenCalled()
  })
})

describe('POST …/toggle — the stamp', () => {
  it('stamps last_applied under the planner’s own key, so the next tick does not re-issue it', async () => {
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).json()
    const row = rowA()
    expect(row.last_applied).toEqual({
      key: overrideKey(row.override), action: 'on', reason: 'override', at: NOW_ISO,
    })
    expect(body.applied).toBe(true)
    expect(body.device.last_applied.key).toBe(overrideKey(row.override))
  })

  it('writes the FULL last_state shape and a last_seen_at', async () => {
    await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    const row = rowA()
    expect(Object.keys(row.last_state).sort()).toEqual(
      ['aenergy_wh', 'apower', 'at', 'online', 'output', 'source', 'temperature_c'].sort(),
    )
    expect(row.last_state).toMatchObject({ output: true, source: 'manual', at: NOW_ISO, online: true })
    expect(row.last_seen_at).toBe(NOW_ISO)
  })

  // SHELLY-UI.9b — a set/switch MEASURES NOTHING. It used to carry the
  // previous watts/energy/temperature forward, which looked conservative and
  // was not: `at` is re-stamped to now, and `at` is what the card reads as
  // "how current is this number", so the reading the plug took while it was
  // OFF would be re-dated to this instant and rendered as a live measurement
  // of a relay we just switched ON. Null renders as "—" and the next cron read
  // fills it within the minute — absent is not zero, and it is not a stale
  // number wearing a new date either.
  it('nulls the measurements it did not take, rather than re-dating stale ones', async () => {
    useDb(world({ last_state: fullState({ output: false, apower: 12.5, aenergy_wh: 900, temperature_c: 31.5 }) }))
    await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(rowA().last_state).toMatchObject({
      online: true, output: true, source: 'manual', at: NOW_ISO,
      apower: null, aenergy_wh: null, temperature_c: null,
    })
    // Still the FULL seven-key shape — a partial last_state is what makes
    // `output` read as "off" when it is really unknown (mig 562's comment).
    expect(Object.keys(rowA().last_state).sort())
      .toEqual(['aenergy_wh', 'apower', 'at', 'online', 'output', 'source', 'temperature_c'])
  })

  it('an OFF toggle lands output:false, never a null that renders as unknown', async () => {
    await POST(toggleReq({ state: 'off' }), ctxFor(DEV_A))
    expect(rowA().last_state.output).toBe(false)
  })

  it('a LOST stamp still reports applied:true — the relay moved', async () => {
    useDb(world())
    db.conf.updateError.shelly_devices = (st) => (st.payload.last_applied ? { message: 'db down' } : null)
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe(true)
    // …and the response does not claim the bookkeeping that failed.
    expect(body.device.last_applied).toBeNull()
    expect(body.device.override).toMatchObject({ state: 'on' })
    expect(logWarn).toHaveBeenCalledWith('shelly-toggle', expect.stringContaining('stamp write failed'), expect.any(Object))
  })
})

describe('POST …/toggle — when the command does not land', () => {
  it('an OFFLINE plug is pending, not failed, and keeps the override', async () => {
    useCloud({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE', statusCode: 200 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, applied: false, pending: true, code: 'pending', kind: 'device' })
    expect(body.message).toMatch(/back online/i)
    expect(rowA().override).toMatchObject({ state: 'on' })
    expect(body.device.override).toMatchObject({ state: 'on' })
  })

  it('a rate limit is a 429 — and still pending', async () => {
    useCloud({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ success: true, applied: false, pending: true, code: 'rate_limited' })
    expect(rowA().override).toMatchObject({ state: 'on' })
  })

  it('an auth failure parks the connection AND keeps the queued override', async () => {
    useCloud({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ applied: false, pending: true, code: 'key_rejected', kind: 'auth' })
    const conn = db.rowsIn('shelly_connections')[0]
    expect(conn.status).toBe('action_needed')
    expect(conn.last_error).toBe(AUTH_ERROR)
    expect(rowA().override).toMatchObject({ state: 'on' })
  })

  it('never leaks the stored key into a failure body', async () => {
    useCloud({ ok: false, kind: 'http', statusCode: 500 })
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).json()
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
  })
})

describe('POST …/toggle — managed vs unmanaged', () => {
  it('an UNMANAGED device says the plug holds until someone changes it', async () => {
    // plan.js rule 2 returns before rule 4, so nothing ever closes this
    // override — `until` bounds the banner, not the relay.
    useDb(world({ enabled: false }))
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).json()
    expect(body.applied).toBe(true)
    expect(body.holds_until_changed).toBe(true)
    expect(body.notice).toBe(HOLDS_NOTICE)
  })

  it('…and so does a device with no schedule at all', async () => {
    useDb(world({ enabled: true, schedule_mode: 'none' }))
    const body = await (await POST(toggleReq({ state: 'off' }), ctxFor(DEV_A))).json()
    expect(body.holds_until_changed).toBe(true)
    expect(body.notice).toBe(HOLDS_NOTICE)
  })

  it('a MANAGED device does not — its schedule resumes at `until`, in both directions', async () => {
    useDb(world({ enabled: true, schedule_mode: 'fixed' }))
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).json()
    // Present and false, never absent: the client reads a boolean rather than
    // inferring one from a missing key.
    expect(body.holds_until_changed).toBe(false)
    expect(body.notice).toBeUndefined()
  })

  it('the PENDING body carries it too — the cron applies the same override', async () => {
    useDb(world({ enabled: false }))
    useCloud({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE', statusCode: 200 })
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))).json()
    expect(body).toMatchObject({ pending: true, holds_until_changed: true, notice: HOLDS_NOTICE })
  })

  it('a bad HOST is pending with its own code, never "within a minute"', async () => {
    useCloud({ ok: false, kind: 'config', statusCode: 0 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ applied: false, pending: true, code: 'bad_host', kind: 'config' })
    expect(body.message).toMatch(/connection settings/i)
    expect(body.message).not.toMatch(/within a minute/i)
  })
})

describe('POST …/toggle — the override schema is the write guard', () => {
  it('refuses, writes nothing and sends nothing when the override cannot be built', async () => {
    // A non-UUID user id fails ShellyOverride.set_by. The point is not the id
    // — it is that an override this route cannot construct is one the planner
    // could not key, so it must never reach the row OR the relay.
    getCurrentUser.mockResolvedValue({ ...OWNER_A, id: 'not-a-uuid' })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect(deviceWrites()).toEqual([])
    expect(rowA().override).toBeNull()
    expect(setSwitch).not.toHaveBeenCalled()
  })
})

describe('POST …/toggle — back to auto', () => {
  it('clears the override, THEN runs the schedule with a zone-bearing connection', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    useDb(world({ override: { state: 'on', until: '2026-08-24T00:00:00.000Z', set_by: OWNER_ID, set_at: NOW_ISO } }))
    runNowForDevice.mockResolvedValue({ ok: true, action: 'off', reason: 'run_now' })

    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(body).toMatchObject({ success: true, applied: 'off', reason: 'run_now' })
    expect(rowA().override).toBeNull()

    const [, conn, device] = runNowForDevice.mock.calls[0]
    // The engine reads its zone from conn.locations — loadConnectionWithKey
    // does not select one, so without the graft this studio would resolve on
    // Dublin time.
    expect(conn.locations).toEqual({ timezone: 'America/New_York' })
    // …and the device it plans against must not still carry the override we
    // just cleared, or it would immediately re-apply it.
    expect(device.override).toBeNull()
    expect(body.device.override).toBeNull()
  })

  it('mode "none" answers no_schedule, not a bare noop', async () => {
    useDb(world({ schedule_mode: 'none' }))
    runNowForDevice.mockResolvedValue({ ok: true, noop: true })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(body).toMatchObject({ applied: null, reason: 'no_schedule' })
  })

  // SHELLY-UI.9b — the third answer was UNREACHABLE and has been removed.
  // runNowForDevice plans with force:true, and under force planDeviceAction
  // has exactly one null path: rule 2, the unmanaged device. Rule 1 answers
  // for any live override, rule 3 for an active window, and rule 4's forced
  // arm catches the rest — so "already right" cannot produce a noop here. A
  // noop for a MANAGED device therefore means the planner and this route
  // disagree, and it is now a loud 500 rather than a cheerful "already on
  // schedule" over a relay nothing touched.
  it('a noop for a MANAGED device is a loud 500, never a false "already correct"', async () => {
    runNowForDevice.mockResolvedValue({ ok: true, noop: true })
    const res = await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('unexpected_noop')
    // The override IS cleared — that write landed before the re-run — so the
    // copy must not imply the operator's request was lost.
    expect(body.device.override).toBeNull()
    expect(body.error).toMatch(/cleared/i)
  })

  it('never answers nothing_to_do — the reason is gone from the vocabulary', async () => {
    runNowForDevice.mockResolvedValue({ ok: true, noop: true })

    useDb(world({ enabled: false, schedule_mode: 'fixed' }))
    const off = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(off.reason).toBe('disabled')

    useDb(world({ schedule_mode: 'none' }))
    const none = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(none.reason).toBe('no_schedule')
  })

  it('500s a failed clear and never runs the schedule', async () => {
    useDb(world())
    db.conf.updateError.shelly_devices = { message: 'db down' }
    const res = await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect(runNowForDevice).not.toHaveBeenCalled()
  })

  it('an auth failure parks the connection and says the device IS back on schedule', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'auth' })
    const res = await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('key_rejected')
    // The reassurance is IN `error` — that is the string the client's default
    // renderer shows on a failure body.
    expect(body.error).toMatch(/back on its schedule/i)
    expect(body.message).toBeUndefined()
    expect(db.rowsIn('shelly_connections')[0].status).toBe('action_needed')
    expect(rowA().override).toBeNull()
  })

  // Whatever happened, the override really is gone in every one of these —
  // the cron picks the schedule up at the next boundary regardless.
  it.each([
    ['rate_limited', { ok: false, kind: 'rate_limited' }, 429],
    ['occurrences', { ok: false, kind: 'occurrences', error: 'db down' }, 502],
    ['bad_device', { ok: false, kind: 'bad_device' }, 500],
    ['network', { ok: false, kind: 'network', statusCode: 0 }, 502],
  ])('maps the engine’s %s to a %i with the override cleared', async (code, result, status) => {
    useDb(world())
    runNowForDevice.mockResolvedValue(result)
    const res = await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
    expect(rowA().override).toBeNull()
  })

  it("names the timetable, not the cloud, when today's occurrences cannot be read", async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'occurrences', error: 'db down' })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(body.error).toMatch(/timetable/i)
    expect(body.error).toMatch(/back on its schedule/i)
  })

  it('bad_device is the ONE failure with no reassurance — the next tick cannot apply it either', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'bad_device' })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(body.code).toBe('bad_device')
    expect(body.error).not.toMatch(/back on its schedule/i)
  })

  it('a device whose schedule is switched OFF answers disabled, not a bare noop', async () => {
    // Two answers, and this is the one a bare noop used to swallow: the
    // operator has a schedule, it is simply not running.
    useDb(world({ enabled: false, schedule_mode: 'fixed' }))
    runNowForDevice.mockResolvedValue({ ok: true, noop: true })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(DEV_A))).json()
    expect(body).toMatchObject({ applied: null, reason: 'disabled' })
  })
})
