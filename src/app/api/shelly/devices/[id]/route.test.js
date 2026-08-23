// SHELLY-UI.5 — PATCH/DELETE one adopted device.
//
// What this suite protects:
//
//  1. THE TENANT FILTER IS ON THE WRITE. The fake holds both studios' rows and
//     applies the recorded .eq()s, so a PATCH that pinned only `id` would edit
//     LOC_B's row and fail here — and the foreign row is asserted BYTE-IDENTICAL
//     afterwards, not merely "the response was a 404".
//  2. THE TWO 404s ARE THE SAME ANSWER. A malformed id and another location's
//     id produce deep-equal bodies; a 400/404 split would be an enumeration
//     oracle.
//  3. DISABLING SAYS WHAT IT DOES NOT DO. Turning a schedule off leaves the
//     relay exactly where it is (plan.js edge d), so the response carries the
//     notice — and only when the row records that WE left it on.
//  4. REMOVING NAMES THE LOSS. shelly_energy_daily cascades from the device
//     row; the message says so.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { PATCH, DELETE, DISABLE_NOTICE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, BAD_ID, OWNER_A, MANAGER_A, STAFF_A,
  deviceRow, makeDb, updatesTo, deletesFrom, jsonReq, req, ctxFor,
} from '../../shelly-routes.test-helpers.js'

const URL_BASE = 'http://localhost/api/shelly/devices/x'
const patchReq = (body) => jsonReq(body, URL_BASE, 'PATCH')
const delReq = () => req(URL_BASE, { method: 'DELETE' })

// Both studios' rows, always — see (1) in the header.
const bothLocations = (over = {}, foreignOver = {}) => ({
  rows: {
    shelly_devices: [
      deviceRow(over),
      deviceRow({ id: DEV_B, location_id: LOC_B, name: 'Their plug', device_id: 'ffeedd998877', ...foreignOver }),
    ],
  },
})

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  useDb(bothLocations())
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('PATCH /api/shelly/devices/[id] — scope', () => {
  it('edits the caller’s own row, pinning the location on the WRITE', async () => {
    const res = await PATCH(patchReq({ name: 'Ice machine' }), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.device.name).toBe('Ice machine')

    const write = updatesTo(db, 'shelly_devices')[0]
    expect(write.filters).toEqual({ id: DEV_A, location_id: LOC_A })
    expect(write.payload.updated_at).toEqual(expect.any(String))
  })

  it('projects the column allowlist — adopted_by never reaches the page', async () => {
    const body = await (await PATCH(patchReq({ name: 'Ice machine' }), ctxFor(DEV_A))).json()
    expect(body.device).not.toHaveProperty('adopted_by')
    expect(body.device).toMatchObject({ id: DEV_A, location_id: LOC_A })
  })

  it('404s another location’s device and leaves that row byte-identical', async () => {
    useDb(bothLocations())
    const before = JSON.stringify(db.rowsIn('shelly_devices').find((r) => r.id === DEV_B))
    const res = await PATCH(patchReq({ name: 'Mine now' }), ctxFor(DEV_B))
    expect(res.status).toBe(404)
    expect(JSON.stringify(db.rowsIn('shelly_devices').find((r) => r.id === DEV_B))).toBe(before)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('404s a malformed id with the SAME body as a foreign one, and writes nothing', async () => {
    const malformed = await PATCH(patchReq({ name: 'x' }), ctxFor(BAD_ID))
    const foreign = await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_B))
    expect(malformed.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await malformed.json()).toEqual(await foreign.json())
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('404s a row that vanished between the load and the write', async () => {
    // The load succeeds; the row is deleted (another tab) in the instant
    // before the UPDATE runs, so it matches nothing. A zero-row UPDATE is not
    // an error in PostgREST — without the !row check the route would answer
    // `device: null` as a success. The error hook fires at update time, which
    // is the only place a test can stand between the two queries.
    useDb(bothLocations())
    db.conf.updateError.shelly_devices = () => {
      db.conf.rows.shelly_devices = []
      return null
    }
    const res = await PATCH(patchReq({ name: 'Ice machine' }), ctxFor(DEV_A))
    expect(res.status).toBe(404)
  })

  it('403s a staff member before anything at all', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_A))).status).toBe(403)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('a MANAGER may edit — device_control is theirs by role default', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_A))).status).toBe(200)
  })
})

describe('PATCH /api/shelly/devices/[id] — the body', () => {
  it('400s an empty patch rather than writing only updated_at', async () => {
    const res = await PATCH(patchReq({}), ctxFor(DEV_A))
    expect(res.status).toBe(400)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('400s an unknown key instead of silently dropping it', async () => {
    const res = await PATCH(patchReq({ nmae: 'typo' }), ctxFor(DEV_A))
    expect(res.status).toBe(400)
  })

  it('400s overlapping windows — the later one would silently never fire', async () => {
    const res = await PATCH(patchReq({
      fixed_windows: [
        { days: [1], on: '07:00', off: '12:00' },
        { days: [1], on: '11:00', off: '13:00' },
      ],
    }), ctxFor(DEV_A))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues?.[0]?.message || body.error).toMatch(/overlap/i)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('accepts a full schedule edit', async () => {
    const windows = [{ days: [1, 2], on: '06:30', off: '10:00' }]
    const body = await (await PATCH(patchReq({ schedule_mode: 'fixed', fixed_windows: windows, enabled: true }), ctxFor(DEV_A))).json()
    expect(body.device.fixed_windows).toEqual(windows)
    expect(body.device.schedule_mode).toBe('fixed')
  })
})

describe('PATCH /api/shelly/devices/[id] — disabling leaves the relay alone', () => {
  it('says so when the row records that WE left it on', async () => {
    useDb(bothLocations({ last_applied: { key: 'w:1', action: 'on', reason: 'window_open', at: '2026-08-23T07:00:00.000Z' } }))
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(DEV_A))).json()
    expect(body.notice).toBe(DISABLE_NOTICE)
    // And nothing was sent to the plug: this route has no cloud client at all.
    expect(body.device.enabled).toBe(false)
  })

  it('stays quiet when the last thing we did was switch it OFF', async () => {
    useDb(bothLocations({ last_applied: { key: 'w:1', action: 'off', reason: 'window_close', at: '2026-08-23T21:00:00.000Z' } }))
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(DEV_A))).json()
    expect(body.notice).toBeUndefined()
  })

  it('stays quiet when nothing has ever been applied', async () => {
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(DEV_A))).json()
    expect(body.notice).toBeUndefined()
  })

  it('stays quiet when the patch is not a disable', async () => {
    useDb(bothLocations({ enabled: false, last_applied: { key: 'w:1', action: 'on', reason: 'window_open', at: 'x' } }))
    const body = await (await PATCH(patchReq({ enabled: true }), ctxFor(DEV_A))).json()
    expect(body.notice).toBeUndefined()
  })
})

describe('PATCH /api/shelly/devices/[id] — failures', () => {
  it('maps a CHECK violation to readable copy, never the raw message', async () => {
    useDb({ ...bothLocations(), updateError: { shelly_devices: { code: '23514', message: 'violates check constraint "shelly_devices_mode_check" value = wat' } } })
    const res = await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_A))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Shelly rejected one of those settings')
    expect(JSON.stringify(body)).not.toContain('check constraint')
  })

  it('500s any other write failure', async () => {
    useDb({ ...bothLocations(), updateError: { shelly_devices: { code: '08006', message: 'db down' } } })
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_A))).status).toBe(500)
  })

  it('500s — not 404 — when the READ failed', async () => {
    useDb({ ...bothLocations(), selectError: { shelly_devices: { message: 'db down' } } })
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(DEV_A))).status).toBe(500)
  })
})

describe('DELETE /api/shelly/devices/[id]', () => {
  it('removes the row and names the energy history it took with it', async () => {
    const res = await DELETE(delReq(), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.message).toMatch(/energy history/i)
    expect(db.rowsIn('shelly_devices').map((r) => r.id)).toEqual([DEV_B])
    expect(deletesFrom(db, 'shelly_devices')[0].filters).toEqual({ id: DEV_A, location_id: LOC_A })
  })

  it('404s another location’s device and deletes nothing', async () => {
    const res = await DELETE(delReq(), ctxFor(DEV_B))
    expect(res.status).toBe(404)
    expect(db.rowsIn('shelly_devices').map((r) => r.id)).toEqual([DEV_A, DEV_B])
    expect(deletesFrom(db, 'shelly_devices')).toEqual([])
  })

  it('404s a malformed id with the same body as a foreign one', async () => {
    const malformed = await DELETE(delReq(), ctxFor(BAD_ID))
    const foreign = await DELETE(delReq(), ctxFor(DEV_B))
    expect(await malformed.json()).toEqual(await foreign.json())
  })

  it('a device that is already gone answers 404 — the client reads that as done', async () => {
    await DELETE(delReq(), ctxFor(DEV_A))
    expect((await DELETE(delReq(), ctxFor(DEV_A))).status).toBe(404)
  })

  it('500s a failed delete rather than reporting a removal that did not happen', async () => {
    useDb({ ...bothLocations(), deleteError: { shelly_devices: { message: 'db down' } } })
    const res = await DELETE(delReq(), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect(db.rowsIn('shelly_devices').map((r) => r.id)).toEqual([DEV_A, DEV_B])
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await DELETE(delReq(), ctxFor(DEV_A))).status).toBe(403)
    expect(deletesFrom(db, 'shelly_devices')).toEqual([])
  })
})
