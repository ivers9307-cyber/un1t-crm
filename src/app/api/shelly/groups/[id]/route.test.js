// SHELLYGROUPS.5 — PATCH/DELETE one group.
//
// The tenant filter is on the WRITE, a foreign id and a malformed one answer
// the same 404, a rename refuses a case-insensitive clash with ANOTHER group
// (renaming "Fans" to "fans" is fine), and deleting switches nothing: the FK
// releases the members (ON DELETE SET NULL).

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
vi.mock('@/lib/shelly/client', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, createShellyClient: vi.fn() }
})

import { PATCH, DELETE, GROUP_DISABLE_NOTICE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import {
  LOC_A, LOC_B, GRP_A, GRP_B, BAD_ID, OWNER_A, STAFF_A,
  groupRow, makeDb, updatesTo, deletesFrom, jsonReq, req, ctxFor,
} from '../../shelly-routes.test-helpers.js'

const URL = 'http://localhost/api/shelly/groups/x'
const GRP_A2 = '90000000-0000-4000-8000-0000000000a2'
const patchReq = (body) => jsonReq(body, URL, 'PATCH')

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
const world = (over = {}, extra = []) => ({
  rows: {
    shelly_groups: [
      groupRow(over),
      groupRow({ id: GRP_A2, name: 'Fans' }),
      groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' }),
      ...extra,
    ],
  },
})
const rowOf = (id) => db.rowsIn('shelly_groups').find((g) => g.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(world())
})

describe('PATCH /api/shelly/groups/[id]', () => {
  it('renames, pinning the location on the write, and never returns last_applied', async () => {
    const res = await PATCH(patchReq({ name: 'Studio lights', icon: 'tv', sort_order: 2 }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.group).toMatchObject({ id: GRP_A, name: 'Studio lights', icon: 'tv', sort_order: 2 })
    expect(body.group).not.toHaveProperty('last_applied')
    expect(updatesTo(db, 'shelly_groups')[0].filters).toEqual({ id: GRP_A, location_id: LOC_A })
  })

  it('refuses a case-insensitive clash with another group at the studio (409 name_taken)', async () => {
    const res = await PATCH(patchReq({ name: 'FANS' }), ctxFor(GRP_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('a re-case of its own name is not a clash', async () => {
    expect((await PATCH(patchReq({ name: 'GYM FLOOR' }), ctxFor(GRP_A))).status).toBe(200)
  })

  it('another studio’s group of the same name is not a clash', async () => {
    expect((await PATCH(patchReq({ name: 'theirs' }), ctxFor(GRP_A))).status).toBe(200)
  })

  it('maps a raw 23505 to 409 name_taken', async () => {
    db.conf.updateError.shelly_groups = { code: '23505', message: 'dup' }
    const res = await PATCH(patchReq({ name: 'New' }), ctxFor(GRP_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
  })

  it('saves a schedule with class_rule defaults filled in', async () => {
    const res = await PATCH(patchReq({ enabled: true, schedule_mode: 'class', class_rule: { days: [1, 2, 3, 4, 5] } }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(rowOf(GRP_A).class_rule).toEqual({ lead_min: 15, lag_min: 10, merge_gap_min: 30, days: [1, 2, 3, 4, 5] })
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('switching a running schedule off says the lights stay as they are', async () => {
    useDb(world({ enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '07:00', off: '09:00' }] }))
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(GRP_A))).json()
    expect(body.notice).toBe(GROUP_DISABLE_NOTICE)
    const quiet = await (await PATCH(patchReq({ name: 'x' }), ctxFor(GRP_A))).json()
    expect(quiet).not.toHaveProperty('notice')
  })

  it('404s a foreign id and a malformed one identically, the foreign row untouched', async () => {
    const before = JSON.stringify(rowOf(GRP_B))
    const foreign = await PATCH(patchReq({ name: 'Mine now' }), ctxFor(GRP_B))
    const malformed = await PATCH(patchReq({ name: 'Mine now' }), ctxFor(BAD_ID))
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await malformed.json())
    expect(JSON.stringify(rowOf(GRP_B))).toBe(before)
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('400s an empty patch and a location_id', async () => {
    expect((await PATCH(patchReq({}), ctxFor(GRP_A))).status).toBe(400)
    expect((await PATCH(patchReq({ location_id: LOC_B }), ctxFor(GRP_A))).status).toBe(400)
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(GRP_A))).status).toBe(403)
  })
})

describe('DELETE /api/shelly/groups/[id]', () => {
  it('deletes the caller’s group, pinning the location, and switches nothing', async () => {
    const res = await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(rowOf(GRP_A)).toBeUndefined()
    expect(deletesFrom(db, 'shelly_groups')[0].filters).toEqual({ id: GRP_A, location_id: LOC_A })
    // Members are released by the FK, not by the route, and nothing is sent.
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('404s a foreign id, the row surviving', async () => {
    const res = await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_B))
    expect(res.status).toBe(404)
    expect(rowOf(GRP_B)).toBeDefined()
    expect(deletesFrom(db, 'shelly_groups')).toEqual([])
  })

  it('500s a failed delete', async () => {
    db.conf.deleteError.shelly_groups = { message: 'pg down' }
    expect((await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))).status).toBe(500)
  })
})
