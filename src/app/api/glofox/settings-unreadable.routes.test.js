// REGISTRYREAD.1b — every staff Glofox route answers a FAILED settings read
// (glofoxCredentialsForLocation → all-null credentials + readError) with a
// 503 "couldn't read the settings", never with "Glofox is not configured" /
// "fill in the missing fields" / an empty class list. And it never calls
// Glofox with the null credentials.
//
// The other half is pinned too: a location that genuinely has no Glofox
// (readError null) still gets exactly the answer it got before. Nothing that
// refused before stops refusing, nothing that proceeded now refuses.
//
// Family C (locations/[id]/glofox-memberships, glofox-trainers) is pinned in
// the route.test.js beside each of those routes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const LOC = 'c0000000-0000-4000-8000-00000000000c'
const CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const HEX = '0123456789abcdef01234567'

const MASTER = {
  id: 'user-m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  activeLocation: { id: LOC },
  locations: [{ id: LOC }],
  rolesByLocation: { [LOC]: 'owner' },
  permissions: {},
}

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermission: vi.fn(() => true) }
})

// A db whose only answer is the synthetic contact (the routes that resolve a
// contact first); anything awaited as a list resolves empty.
function fakeDb() {
  const chain = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'not', 'is', 'order', 'range', 'limit', 'filter', 'gte', 'lte']) chain[m] = () => chain
  chain.maybeSingle = async () => ({ data: { id: CONTACT, location_id: LOC, glofox_member_id: HEX, name: 'Test Person', first_name: 'Test' }, error: null })
  chain.single = chain.maybeSingle
  chain.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
  return { from: () => chain }
}
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => fakeDb()) }))

const { mustNotCall } = vi.hoisted(() => ({
  mustNotCall: (name) => vi.fn(async () => { throw new Error(`${name} must not be called with unreadable settings`) }),
}))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(),
  glofoxFetch: mustNotCall('glofoxFetch'),
  createBooking: mustNotCall('createBooking'),
  cancelBooking: mustNotCall('cancelBooking'),
  fetchUpcomingEvents: mustNotCall('fetchUpcomingEvents'),
  fetchPaymentsReport: mustNotCall('fetchPaymentsReport'),
  fetchAllMembersPage: mustNotCall('fetchAllMembersPage'),
  fetchUserBookings: mustNotCall('fetchUserBookings'),
}))
vi.mock('@/lib/class-occurrences', async (importOriginal) => ({
  ...(await importOriginal()),
  syncOccurrencesForLocation: vi.fn(async () => ({ ok: true, upserted: 0 })),
}))
vi.mock('@/lib/class-climate-runner', () => ({
  runClassClimate: vi.fn(async () => ({ locations: [{ planned: [], actions: [], errors: [] }] })),
}))
vi.mock('@/lib/bathroom-climate-runner', () => ({
  runBathroomClimate: vi.fn(async () => ({ locations: [{ planned: [], actions: [], errors: [] }] })),
}))

import { getCurrentUser } from '@/lib/auth'
import * as glofox from '@/lib/glofox'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'

import * as bookingsCancel from './bookings/cancel/route.js'
import * as bulkSync from './bulk-sync/route.js'
import * as paymentsReport from './payments-report/route.js'
import * as reconcileArrears from './reconcile-arrears/route.js'
import * as reconcileFees from './reconcile-fees/route.js'
import * as syncMember from './sync-member/route.js'
import * as backfillClassBookings from '../admin/backfill-class-bookings/route.js'
import * as refreshMember from '../churn-radar/refresh-member/route.js'
import * as classesBook from './classes/book/route.js'
import * as classesCancel from './classes/cancel/route.js'
import * as classes from './classes/route.js'
import * as ping from './ping/route.js'
import * as probe from './probe/route.js'
import * as listMembers from './list-members/route.js'
import * as runNow from '../automations/[key]/run-now/route.js'

const UNREADABLE = { branchId: null, apiKey: null, apiToken: null, readError: GLOFOX_SETTINGS_UNREADABLE }
const NOT_CONFIGURED = { branchId: null, apiKey: null, apiToken: null, readError: null }

const get = (path) => new Request(`http://crm.test${path}`)
const post = (path, body) => new Request(`http://crm.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

// [label, handler, request factory, family, the not-configured answer main gives]
const ROUTES = [
  ['glofox/bookings/cancel', bookingsCancel.POST, () => post('/api/glofox/bookings/cancel', { location_id: LOC, booking_id: 'b-1', user_id: 'u-1' }), 'A', 400],
  ['glofox/bulk-sync', bulkSync.POST, () => post('/api/glofox/bulk-sync', { location_id: LOC }), 'A', 400],
  ['glofox/payments-report', paymentsReport.GET, () => get(`/api/glofox/payments-report?location_id=${LOC}`), 'A', 400],
  ['glofox/reconcile-arrears', reconcileArrears.GET, () => get(`/api/glofox/reconcile-arrears?location_id=${LOC}`), 'A', 400],
  ['glofox/reconcile-fees', reconcileFees.GET, () => get(`/api/glofox/reconcile-fees?location_id=${LOC}`), 'A', 400],
  ['glofox/sync-member', syncMember.GET, () => get(`/api/glofox/sync-member?member_id=${HEX}&location_id=${LOC}`), 'A', 400],
  ['admin/backfill-class-bookings', backfillClassBookings.POST, () => post(`/api/admin/backfill-class-bookings?location_id=${LOC}`, {}), 'B', 400],
  ['churn-radar/refresh-member', refreshMember.POST, () => post('/api/churn-radar/refresh-member', { contact_id: CONTACT }), 'B', 400],
  ['glofox/classes/book', classesBook.POST, () => post('/api/glofox/classes/book', { contact_id: CONTACT, event_id: HEX }), 'B', 400],
  ['glofox/classes/cancel', classesCancel.POST, () => post('/api/glofox/classes/cancel', { contact_id: CONTACT, booking_id: HEX }), 'B', 400],
  ['glofox/classes', classes.GET, () => get(`/api/glofox/classes?location_id=${LOC}`), 'B', 200],
  ['glofox/ping', ping.GET, () => get(`/api/glofox/ping?location_id=${LOC}`), 'D', 200],
  ['glofox/probe', probe.GET, () => get(`/api/glofox/probe?location_id=${LOC}&path=/2.0/memberships`), 'D', 200],
  ['glofox/list-members', listMembers.GET, () => get(`/api/glofox/list-members?location_id=${LOC}`), 'D', 200],
]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test') }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('REGISTRYREAD.1b — a failed settings read answers 503, not "not configured"', () => {
  it.each(ROUTES)('%s', async (_label, handler, req, family) => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(UNREADABLE)
    const res = await handler(req())
    expect(glofox.glofoxCredentialsForLocation).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(res.status).toBe(503)
    const j = await res.json()
    if (family === 'A') {
      expect(j).toEqual({ ok: false, code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    } else if (family === 'B') {
      expect(j).toEqual({ success: false, code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    } else {
      // configured: null means "unknown", not "no".
      expect(j).toEqual({
        ok: false, configured: null, location_id: LOC,
        code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE,
      })
    }
    expect(glofox.glofoxFetch).not.toHaveBeenCalled()
    expect(glofox.createBooking).not.toHaveBeenCalled()
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
    expect(glofox.fetchUpcomingEvents).not.toHaveBeenCalled()
    expect(glofox.fetchPaymentsReport).not.toHaveBeenCalled()
    expect(glofox.fetchAllMembersPage).not.toHaveBeenCalled()
  })
})

describe('REGISTRYREAD.1b — a studio with no Glofox answers exactly as before', () => {
  it.each(ROUTES)('%s', async (_label, handler, req, family, mainStatus) => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(NOT_CONFIGURED)
    const res = await handler(req())
    expect(res.status).toBe(mainStatus)
    const j = await res.json()
    expect(j.code).toBeUndefined()
    expect(JSON.stringify(j)).not.toContain(GLOFOX_SETTINGS_UNREADABLE)
    if (family === 'D') expect(j.configured).toBe(false)
  })
})

describe('REGISTRYREAD.1b — run-now still runs, and says why the class sync was skipped', () => {
  const call = () => runNow.POST(
    post('/api/automations/class_climate/run-now', { location_id: LOC, dry_run: true }),
    { params: Promise.resolve({ key: 'class_climate' }) },
  )

  it('an unreadable settings row: 200, sync skipped, glofox_settings_unreadable true', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(UNREADABLE)
    const res = await call()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.glofox_configured).toBe(false)
    expect(j.glofox_settings_unreadable).toBe(true)
    expect(syncOccurrencesForLocation).not.toHaveBeenCalled()
  })

  it('a studio with no Glofox: glofox_settings_unreadable false', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(NOT_CONFIGURED)
    const j = await (await call()).json()
    expect(j.glofox_configured).toBe(false)
    expect(j.glofox_settings_unreadable).toBe(false)
  })
})
