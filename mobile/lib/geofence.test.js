// GEOFENCE-TRANSPORT.1 — flushQueue's keep-or-drop decision.
//
// A queued geofence check-in is retried only on a TRANSIENT failure and
// dropped on a server rejection (retrying an exempt/disabled ping forever
// is noise). Until this change the transient cases were recognised by
// regex on the error STRING api() mints ("Network error: …",
// "Non-JSON response (5xx)"), which silently stops matching the day
// someone rewords the message. api() now tags its own envelopes
// `transport: true` (SONOSMOB.4c) and carries the HTTP status on the
// non-JSON one, so the decision reads fields. These tests pin every
// branch of that decision, including the one the old regex was scoped
// to: a non-JSON 4xx (an HTML 404 from a wrong base URL) is NOT
// transient and must not be retried forever.
//
// expo-* and ./api are mocked before import: geofence.js registers a
// background task at module top level and the RN runtime must never
// load under vitest's Node environment.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = new Map()
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => { store.set(k, v) }),
  deleteItemAsync: vi.fn(async (k) => { store.delete(k) }),
}))
vi.mock('expo-task-manager', () => ({ defineTask: vi.fn() }))
vi.mock('expo-location', () => ({ GeofencingEventType: { Enter: 1, Exit: 2 } }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./impersonate', () => ({ readImpersonate: vi.fn(async () => null) }))
vi.mock('./geofence-permission', () => ({ resolveGeofencePermission: vi.fn() }))

import { api } from './api'
import { enqueueCheckin, flushQueue } from './geofence'

const QUEUE_KEY = 'geo_att_queue_v1'
const queued = () => JSON.parse(store.get(QUEUE_KEY) || '[]')

beforeEach(async () => {
  store.clear()
  vi.clearAllMocks()
  await enqueueCheckin('loc-1')
  expect(queued()).toHaveLength(1)
})

describe('flushQueue keeps a check-in on a transient failure', () => {
  it('a dropped fetch (transport: true, no status)', async () => {
    api.mockResolvedValue({ success: false, transport: true, error: 'Network error: TypeError: Network request failed' })
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })

  it('a non-JSON 5xx body (transport: true, status 502) — an edge error page', async () => {
    api.mockResolvedValue({ success: false, transport: true, status: 502, error: 'Non-JSON response (502)' })
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })

  it('a bare non-2xx JSON without our envelope ("HTTP 5xx") — reached the server, untagged', async () => {
    api.mockResolvedValue({ success: false, error: 'HTTP 503' })
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })

  it('the checkin route\'s own transient:true envelope', async () => {
    api.mockResolvedValue({ success: false, transient: true, error: 'connection reset by peer' })
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })

  it('a thrown call (api() is never expected to throw, but the queue must survive it)', async () => {
    api.mockRejectedValue(new Error('boom'))
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })

  it('does NOT depend on the wording of the error string', async () => {
    // The whole point of the change: reword api()'s message and the
    // decision must not move.
    api.mockResolvedValue({ success: false, transport: true, error: 'the network went away' })
    await flushQueue()
    expect(queued()).toHaveLength(1)
  })
})

describe('flushQueue drops a check-in on a terminal answer', () => {
  it('a server rejection (JSON success:false, untagged)', async () => {
    api.mockResolvedValue({ success: false, error: 'Geofence attendance is off for this location' })
    await flushQueue()
    expect(queued()).toHaveLength(0)
  })

  it('a bare non-2xx JSON that is a 4xx ("HTTP 404")', async () => {
    api.mockResolvedValue({ success: false, error: 'HTTP 404' })
    await flushQueue()
    expect(queued()).toHaveLength(0)
  })

  it('a non-JSON 4xx body (transport: true, status 404) — a wrong base URL, not a blip', async () => {
    // The old regex was deliberately scoped to 5xx for exactly this case;
    // the tag alone would retry an HTML 404 forever.
    api.mockResolvedValue({ success: false, transport: true, status: 404, error: 'Non-JSON response (404)' })
    await flushQueue()
    expect(queued()).toHaveLength(0)
  })

  it('success', async () => {
    api.mockResolvedValue({ success: true })
    await flushQueue()
    expect(queued()).toHaveLength(0)
  })
})
