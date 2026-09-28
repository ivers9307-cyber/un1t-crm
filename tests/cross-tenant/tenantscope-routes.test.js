// TENANTSCOPE.1 — the routes C7 found crossing organisations (not the
// role-at-location class): accounting/health's LLM spend, the staff fleet
// (GET + nudge), the test push, the two host back-fill jobs, and the cars
// VAT/revenue CSV export.
//
// Same posture as session-routes.test.js: real handlers, the real
// @/lib/auth guards and the real @/lib/permissions resolver; only
// getCurrentUser is swapped for the persona, over the filter-aware
// two-tenant double (fixture.js). A handler that forgets its organisation
// or location filter RECEIVES org B's rows and fails the assertion.
// Do NOT weaken an assertion to make it pass.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
// The push pipeline is not under test here — WHO it is asked to reach is.
vi.mock('@/lib/push', () => ({
  sendPush: vi.fn(async (ids) => ({ sent: ids.length, skipped: 0, invalidated: 0, failed: 0 })),
}))
vi.mock('@/lib/fx', () => ({ getCachedGbpToEur: vi.fn(async () => ({ rate: 1.17 })) }))
vi.mock('@/lib/host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn(async () => 3) }))
vi.mock('@/lib/host-lead-migration', () => ({
  runHostLeadMigration: vi.fn(async (_db, opts) => ({ dry_run: opts.dryRun, planned: 0, moved: 0 })),
}))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { sendPush } from '@/lib/push'
import { addEventAttendeesToHostList } from '@/lib/host-contact-list'
import { runHostLeadMigration } from '@/lib/host-lead-migration'
import {
  makeWorld, makeTenantDb, makeReq, jsonOf, idsOf, users, withActiveLocation, tid,
  ORG_A, ORG_B, LOC_A1, LOC_B1,
  P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_ORGADMIN_A,
  P_STAFF_B1, P_OWNER_B1, P_STAFF_B2, P_MASTER,
} from './fixture.js'

import * as health from '@/app/api/accounting/health/route.js'
import * as carsExport from '@/app/api/cars/reports/export/route.js'
import * as staffDevices from '@/app/api/staff-devices/route.js'
import * as nudge from '@/app/api/staff-devices/nudge/route.js'
import * as pushTest from '@/app/api/admin/push/test/route.js'
import * as backfillHosts from '@/app/api/admin/backfill-host-contacts/route.js'
import * as migrateHostLeads from '@/app/api/admin/migrate-host-leads/route.js'

// ─── the extra tables these routes read ─────────────────────────────
const BL_A1 = tid('b1a1'); const BL_B1 = tid('b1b1') // recon_bank_lines
const HUNT_A1 = tid('4a01'); const HUNT_B1 = tid('4b01')
const RUN_A1 = tid('3a01'); const RUN_B1 = tid('3b01'); const RUN_REPORT = tid('3e00')
const MB_A1 = tid('ba01'); const MB_B1 = tid('bb01')
const CAR_A1 = tid('ca01'); const CAR_B1 = tid('cb01')
const DT_A1 = tid('da01'); const DT_B1 = tid('db01'); const DT_B2 = tid('db02')
const HOST_A = tid('40a0'); const HOST_B = tid('40b0')
const EV_A = tid('e0a0'); const EV_B = tid('e0b0'); const EV_STUDIO_B = tid('e0c0')

const A_FLEET = [P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_ORGADMIN_A].sort()
const ALL_PROFILES = [P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_STAFF_B1, P_OWNER_B1, P_STAFF_B2, P_ORGADMIN_A, P_MASTER].sort()

function tenantScopeWorld() {
  const w = makeWorld()
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString() // an hour ago
  w.recon_bank_lines = [
    { id: BL_A1, location_id: LOC_A1 },
    { id: BL_B1, location_id: LOC_B1 },
  ]
  // recon_hunts has NO location_id: the route reaches a studio through the
  // hunt's bank line, so each row carries the embed the !inner select returns.
  w.recon_hunts = [
    { id: HUNT_A1, bank_line_id: BL_A1, started_at: at, llm_spend_usd: 2, recon_bank_lines: { location_id: LOC_A1 } },
    { id: HUNT_B1, bank_line_id: BL_B1, started_at: at, llm_spend_usd: 9, recon_bank_lines: { location_id: LOC_B1 } },
  ]
  w.recon_runs = [
    { id: RUN_A1, location_id: LOC_A1, trigger: 'cron', status: 'ok', started_at: at, finished_at: at, error: null, stats: {} },
    { id: RUN_B1, location_id: LOC_B1, trigger: 'cron', status: 'error', started_at: at, finished_at: at, error: 'org B xero token expired', stats: {} },
    { id: RUN_REPORT, location_id: null, trigger: 'report', status: 'ok', started_at: at, finished_at: at, error: null, stats: { locations: 2 } },
  ]
  w.recon_mailboxes = [
    { id: MB_A1, location_id: LOC_A1, label: 'hunt inbox A', email: 'hunt.a1@a.com', active: true, last_ok_at: at, last_error: null, created_at: at },
    { id: MB_B1, location_id: LOC_B1, label: 'hunt inbox B', email: 'hunt.b1@b.com', active: true, last_ok_at: at, last_error: null, created_at: at },
  ]
  w.cron_heartbeats = [
    { name: 'receipt-coverage-weekly', last_ok_at: at, expected_interval_seconds: 604800, grace_seconds: 86400, notes: null },
    { name: 'process-receipt-hunts', last_ok_at: at, expected_interval_seconds: 300, grace_seconds: 600, notes: null },
  ]
  w.cars = [
    { id: CAR_A1, location_id: LOC_A1, status: 'in_transit', uk_reg: 'AA11 AAA', irish_reg: null, vin: 'VINA1', make: 'Tesla', model: 'Model 3', vehicle_year: 2024, uk_vat: 1000, uk_vat_refund_received: false, created_at: at, completed_at: null },
    { id: CAR_B1, location_id: LOC_B1, status: 'in_transit', uk_reg: 'BB22 BBB', irish_reg: null, vin: 'VINB1', make: 'Tesla', model: 'Model Y', vehicle_year: 2024, uk_vat: 2000, uk_vat_refund_received: false, created_at: at, completed_at: null },
  ]
  // One app binary for the estate: org B's newest phone sets the target
  // (2.5.0), so staff A-One's and staff B-One's 2.4.0 are both outdated.
  const device = (id, userId, version, token) => ({
    id, user_id: userId, platform: 'ios', device_name: `phone-${token}`, app_version: version,
    last_seen_at: at, created_at: at, geofence_permission: null, geofence_permission_at: null,
    last_update_nudge_at: null, expo_push_token: `ExponentPushToken[${token}]`, native_build: null,
  })
  w.device_tokens = [
    device(DT_A1, P_STAFF_A1, '2.4.0', 'a1'),
    device(DT_B1, P_STAFF_B1, '2.4.0', 'b1'),
    device(DT_B2, P_STAFF_B2, '2.5.0', 'b2'),
  ]
  w.event_hosts = [
    { id: HOST_A, organization_id: ORG_A, name: 'Host A' },
    { id: HOST_B, organization_id: ORG_B, name: 'Host B' },
  ]
  w.race_events = [
    { id: EV_A, name: 'Race A', host_id: HOST_A, location_id: LOC_A1 },
    { id: EV_B, name: 'Race B', host_id: HOST_B, location_id: LOC_B1 },
    { id: EV_STUDIO_B, name: 'Studio race B', host_id: null, location_id: LOC_B1 },
  ]
  return w
}

let db
function useWorld(world) {
  db = makeTenantDb(world)
  vi.mocked(createServerClient).mockReturnValue(db)
}
beforeEach(() => {
  vi.clearAllMocks()
  useWorld(tenantScopeWorld())
})
const as = (persona) => vi.mocked(getCurrentUser).mockResolvedValue(persona)
// A per-person grant at the active studio (tier 2 of resolvePermission).
const withPerm = (u, key) => ({
  ...u,
  activeAssignment: {
    role: u.role, is_default: false, unifi_door_access: false,
    ...(u.activeAssignment || {}),
    permissions: { ...(u.activeAssignment?.permissions || {}), [key]: true },
  },
})
const noActive = (u) => ({ ...u, activeLocation: null, activeOrganization: null })

// ─── accounting/health ───────────────────────────────────────────────
describe('GET /api/accounting/health — a studio sees its own LLM spend (TENANTSCOPE.1)', () => {
  it("an owner at A One sees A One's 7-day spend, never the estate total", async () => {
    as(users.ownerA1())
    const { status, json } = await jsonOf(await health.GET())
    expect(status).toBe(200)
    expect(json.data.spend7dUsd).toBe(2) // main: 11 (A One 2 + org B 9)
    expect(json.data).not.toHaveProperty('spend7dUsdAll')
    expect(json.data.budget).toEqual({ weeklyUsd: 15, exhausted: false })
  })

  it('says the SHARED budget is reached without saying who spent it', async () => {
    const world = tenantScopeWorld()
    world.recon_hunts[1].llm_spend_usd = 14 // org B alone; estate = 16 >= 15
    useWorld(world)
    as(users.ownerA1())
    const { json } = await jsonOf(await health.GET())
    expect(json.data.spend7dUsd).toBe(2)
    expect(json.data.budget).toEqual({ weeklyUsd: 15, exhausted: true })
    expect(Object.keys(json.data).sort()).toEqual(['budget', 'heartbeats', 'mailboxes', 'runs', 'spend7dUsd'])
  })

  it("lists A One's runs + the estate weekly-report row, and A One's inboxes only", async () => {
    as(users.ownerA1())
    const { json } = await jsonOf(await health.GET())
    expect(idsOf(json.data.runs)).toEqual([RUN_A1, RUN_REPORT].sort())
    expect(idsOf(json.data.mailboxes)).toEqual([MB_A1])
    expect(JSON.stringify(json)).not.toContain('hunt.b1@b.com')
    expect(JSON.stringify(json)).not.toContain('org B xero token expired')
  })

  it("a master sees the active studio's spend AND the estate total", async () => {
    as(users.master()) // active at A One
    const { json } = await jsonOf(await health.GET())
    expect(json.data.spend7dUsd).toBe(2) // main: 11
    expect(json.data.spend7dUsdAll).toBe(11)
    expect(json.data.budget).toEqual({ weeklyUsd: 15, exhausted: false })
  })
})

// ─── the staff fleet ─────────────────────────────────────────────────
describe("GET /api/staff-devices — the active organisation's fleet (TENANTSCOPE.1)", () => {
  it("a manager at A One sees org A's staff (members + org admin), never org B's", async () => {
    as(users.managerA1())
    const { status, json } = await jsonOf(await staffDevices.GET())
    expect(status).toBe(200)
    expect(idsOf(json.data.staff)).toEqual(A_FLEET) // main: all nine profiles
    expect(JSON.stringify(json)).not.toContain('@b.com')
    expect(JSON.stringify(json)).not.toContain('phone-b1')
  })

  it('keeps the target version estate-wide — one app binary', async () => {
    as(users.managerA1())
    const { json } = await jsonOf(await staffDevices.GET())
    expect(json.data.target_version).toBe('2.5.0') // set by org B's newest phone
    const a1 = json.data.staff.find((s) => s.id === P_STAFF_A1)
    expect(a1.verdict.kind).toBe('outdated')
  })

  it('a master still sees the whole estate', async () => {
    as(users.master())
    const { json } = await jsonOf(await staffDevices.GET())
    expect(idsOf(json.data.staff)).toEqual(ALL_PROFILES)
  })

  it('a non-master with no active organisation sees nobody', async () => {
    as(noActive(users.managerA1()))
    const { status, json } = await jsonOf(await staffDevices.GET())
    expect(status).toBe(200)
    expect(json.data.staff).toEqual([]) // main: all nine profiles
  })
})

describe('POST /api/staff-devices/nudge — only your own organisation (TENANTSCOPE.1)', () => {
  const nudgeReq = (ids) => makeReq('/api/staff-devices/nudge', { method: 'POST', body: { profile_ids: ids } })

  it("a manager at A One cannot push to org B's outdated staff", async () => {
    as(users.managerA1())
    const { status, json } = await jsonOf(await nudge.POST(nudgeReq([P_STAFF_B1])))
    expect(status).toBe(200)
    expect(json.data).toEqual({ sent: 0, skipped_throttled: 0, skipped_no_app: 0, skipped_no_token: 0 }) // main: sent 1
    expect(sendPush).not.toHaveBeenCalled()
    expect(db._writesTo('device_tokens')).toEqual([]) // nothing claimed either
  })

  it("nudges org A's outdated staff and drops the org B id from a mixed list", async () => {
    as(users.managerA1())
    const { json } = await jsonOf(await nudge.POST(nudgeReq([P_STAFF_A1, P_STAFF_B1])))
    expect(json.data.sent).toBe(1)
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendPush).mock.calls[0][0]).toEqual([P_STAFF_A1]) // main: [A1, B1]
  })

  it('a master can nudge anyone in the estate', async () => {
    as(users.master())
    const { json } = await jsonOf(await nudge.POST(nudgeReq([P_STAFF_B1])))
    expect(json.data.sent).toBe(1)
    expect(vi.mocked(sendPush).mock.calls[0][0]).toEqual([P_STAFF_B1])
  })
})

// ─── the test push ───────────────────────────────────────────────────
describe('POST /api/admin/push/test — only someone in your own organisation (TENANTSCOPE.1)', () => {
  const pushReq = (id) => makeReq('/api/admin/push/test', { method: 'POST', body: { recipient_id: id } })

  it("an owner at A One gets the unknown-id 404 for org B's staff, and nothing is sent", async () => {
    as(users.ownerA1())
    const cross = await jsonOf(await pushTest.POST(pushReq(P_STAFF_B1)))
    const unknown = await jsonOf(await pushTest.POST(pushReq(tid('dead'))))
    expect(cross.status).toBe(404) // main: 200 and a push to org B's phone
    expect(cross).toEqual(unknown)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('still tests someone at A One', async () => {
    as(users.ownerA1())
    const { status } = await jsonOf(await pushTest.POST(pushReq(P_STAFF_A1)))
    expect(status).toBe(200)
    expect(vi.mocked(sendPush).mock.calls[0][0]).toEqual([P_STAFF_A1])
  })

  it('a master can test anyone in the estate', async () => {
    as(users.master())
    const { status } = await jsonOf(await pushTest.POST(pushReq(P_STAFF_B1)))
    expect(status).toBe(200)
  })
})

// ─── the two host jobs ───────────────────────────────────────────────
describe("POST /api/admin/backfill-host-contacts — your organisation's hosts only (TENANTSCOPE.1)", () => {
  it("an owner at A One back-fills org A's hosted events only", async () => {
    as(users.ownerA1())
    const { status, json } = await jsonOf(await backfillHosts.POST())
    expect(status).toBe(200)
    expect(idsOf(json.data.events, 'event_id')).toEqual([EV_A]) // main: [EV_A, EV_B]
    expect(vi.mocked(addEventAttendeesToHostList).mock.calls.map((c) => c[1])).toEqual([EV_A])
    expect(JSON.stringify(json)).not.toContain('Race B')
  })

  it('a master back-fills every hosted event in the estate', async () => {
    as(users.master())
    const { json } = await jsonOf(await backfillHosts.POST())
    expect(idsOf(json.data.events, 'event_id')).toEqual([EV_A, EV_B].sort())
  })

  it('a non-master with no active organisation is refused, and nothing runs', async () => {
    as(noActive(users.ownerA1()))
    const { status, json } = await jsonOf(await backfillHosts.POST())
    expect(status).toBe(400) // main: 200, every organisation's events
    expect(json.error).toBe('No active organisation')
    expect(addEventAttendeesToHostList).not.toHaveBeenCalled()
  })
})
