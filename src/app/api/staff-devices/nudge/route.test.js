// Coverage for POST /api/staff-devices/nudge — the "you're on an old
// build, please update" push.
//
// Two things here are security-critical rather than cosmetic:
//   1. The gate. This is a service-role route, so RLS does nothing; the
//      hasPermission(user,'settings') check is the only thing stopping
//      any staffer from spamming the whole fleet.
//   2. Who is outdated is recomputed SERVER-SIDE. The client sends ids,
//      never verdicts — a caller must not be able to nudge someone who
//      is perfectly up to date by asserting they aren't.
// The 24h throttle is the third: it is what stops a repeated click (or
// a repeated request) from firing the same push over and over.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermission } = await import('@/lib/permissions')
const { sendPush } = await import('@/lib/push')
const { POST } = await import('./route.js')

const DAY = 86400_000
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString()
const hoursAgo = (n) => new Date(Date.now() - n * 3600_000).toISOString()

// UUID-shaped ids — the schema uses uuidLike, so 'p1' would 400.
const ID = {
  outdated: '11111111-1111-1111-1111-111111111111',
  current: '22222222-2222-2222-2222-222222222222',
  noDevice: '33333333-3333-3333-3333-333333333333',
  throttled: '44444444-4444-4444-4444-444444444444',
}

// Thenable builder mock. Records every call so the query shape (which is
// the route's correctness) can be asserted, and captures the update
// patch + the ids it was scoped to.
function makeDb(tables, sink = {}) {
  sink.calls = sink.calls || []
  sink.updates = sink.updates || []
  return {
    from(table) {
      let patch = null
      const builder = {
        select: (cols) => { sink.calls.push(['select', table, cols]); return builder },
        update: (row) => { patch = row; return builder },
        eq: (col, val) => { sink.calls.push(['eq', table, col, val]); return builder },
        order: (col, opts) => { sink.calls.push(['order', table, col, opts?.ascending]); return builder },
        range: (from, to) => { sink.calls.push(['range', table, from, to]); return builder },
        in: (col, vals) => {
          sink.calls.push(['in', table, col, vals])
          if (patch) sink.updates.push({ table, patch, col, ids: vals })
          return builder
        },
        then: (resolve) =>
          Promise.resolve({ data: patch ? null : (tables[table] ?? []), error: null }).then(resolve),
      }
      return builder
    },
  }
}

const req = (body) =>
  new Request('http://localhost/api/staff-devices/nudge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// One outdated staffer, one on the target build, one with no device at
// all, and one outdated staffer who was already nudged an hour ago.
const FLEET = {
  profiles: [
    { id: ID.outdated, full_name: 'Behind', email: 'b@x.ie', role: 'staff', active: true },
    { id: ID.current, full_name: 'Up To Date', email: 'u@x.ie', role: 'staff', active: true },
    { id: ID.noDevice, full_name: 'No App', email: 'n@x.ie', role: 'staff', active: true },
    { id: ID.throttled, full_name: 'Just Nudged', email: 'j@x.ie', role: 'staff', active: true },
  ],
  device_tokens: [
    {
      id: 'd-outdated', user_id: ID.outdated, app_version: '2.1.0',
      last_seen_at: daysAgo(1), last_update_nudge_at: null,
    },
    {
      id: 'd-current', user_id: ID.current, app_version: '2.2.0',
      last_seen_at: daysAgo(0), last_update_nudge_at: null,
    },
    {
      id: 'd-throttled', user_id: ID.throttled, app_version: '2.1.0',
      last_seen_at: daysAgo(2), last_update_nudge_at: hoursAgo(1),
    },
  ],
}

const settingsUser = { id: 'u-admin', profileRole: 'owner' }
const allIds = Object.values(ID)

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(settingsUser)
  sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
})

describe('POST /api/staff-devices/nudge', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('403s without the settings permission, before touching the DB', async () => {
    hasPermission.mockReturnValue(false)
    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('sends only to the genuinely outdated — the client cannot nominate victims', async () => {
    const sink = {}
    createServerClient.mockReturnValue(makeDb(FLEET, sink))

    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(sendPush).toHaveBeenCalledTimes(1)
    // The up-to-date staffer and the one with no app are never pushed,
    // no matter that the client asked for them.
    expect(sendPush.mock.calls[0][0]).toEqual([ID.outdated])

    expect(json.success).toBe(true)
    expect(json.data).toEqual({ sent: 1, skipped_throttled: 1, skipped_no_token: 1 })
  })

  it('skips (and counts) a profile nudged inside the last 24h', async () => {
    createServerClient.mockReturnValue(makeDb(FLEET))
    const json = await (await POST(req({ profile_ids: [ID.throttled] }))).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(json.data).toEqual({ sent: 0, skipped_throttled: 1, skipped_no_token: 0 })
  })

  it('nudges again once the throttle window has passed', async () => {
    createServerClient.mockReturnValue(makeDb({
      ...FLEET,
      device_tokens: [
        { ...FLEET.device_tokens[0] },
        { ...FLEET.device_tokens[1] },
        { ...FLEET.device_tokens[2], last_update_nudge_at: daysAgo(2) },
      ],
    }))
    const json = await (await POST(req({ profile_ids: [ID.throttled] }))).json()
    expect(sendPush.mock.calls[0][0]).toEqual([ID.throttled])
    expect(json.data.sent).toBe(1)
  })

  it('stamps last_update_nudge_at on the devices it actually nudged', async () => {
    const sink = {}
    createServerClient.mockReturnValue(makeDb(FLEET, sink))
    await POST(req({ profile_ids: allIds }))

    expect(sink.updates).toHaveLength(1)
    const [update] = sink.updates
    expect(update.table).toBe('device_tokens')
    expect(update.col).toBe('id')
    // Only the outdated staffer's CURRENT device row — never the
    // up-to-date one, and never the already-throttled one.
    expect(update.ids).toEqual(['d-outdated'])
    expect(typeof update.patch.last_update_nudge_at).toBe('string')
  })

  it('uses the default copy, and lets a custom message override the body', async () => {
    createServerClient.mockReturnValue(makeDb(FLEET))
    await POST(req({ profile_ids: [ID.outdated] }))
    const defaultBody = sendPush.mock.calls[0][1].body
    expect(defaultBody).toMatch(/update/i)

    vi.clearAllMocks()
    hasPermission.mockReturnValue(true)
    getCurrentUser.mockResolvedValue(settingsUser)
    sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
    createServerClient.mockReturnValue(makeDb(FLEET))
    await POST(req({ profile_ids: [ID.outdated], message: 'New build in TestFlight, please grab it.' }))
    const payload = sendPush.mock.calls[0][1]
    expect(payload.body).toBe('New build in TestFlight, please grab it.')
    expect(payload.body).not.toBe(defaultBody)
    expect(payload.data.type).toBe('app_update')
  })

  it('sends WITHOUT a category, or the whole fleet would be silently skipped', async () => {
    // sendPush gates a categorised push on notify_<category>, and
    // resolvePermission's final tier is `defaults[role][key] === true` —
    // an UNREGISTERED key therefore resolves to FALSE, not "no opinion".
    // A `category: 'app_update'` here would skip every staffer with a
    // location assignment and the nudge would reach nobody. Android
    // routing rides data.type instead (TYPE_CHANNELS.app_update).
    createServerClient.mockReturnValue(makeDb(FLEET))
    await POST(req({ profile_ids: [ID.outdated] }))
    expect(sendPush.mock.calls[0][1].category).toBeUndefined()
  })

  it('400s on a message longer than 200 characters', async () => {
    createServerClient.mockReturnValue(makeDb(FLEET))
    const res = await POST(req({ profile_ids: [ID.outdated], message: 'x'.repeat(201) }))
    expect(res.status).toBe(400)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('400s on a non-uuid profile id', async () => {
    createServerClient.mockReturnValue(makeDb(FLEET))
    const res = await POST(req({ profile_ids: ['not-a-uuid'] }))
    expect(res.status).toBe(400)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('reports a push failure in the counts instead of 500ing', async () => {
    const sink = {}
    createServerClient.mockReturnValue(makeDb(FLEET, sink))
    sendPush.mockRejectedValue(new Error('expo down'))

    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.sent).toBe(0)
    // Nothing was delivered, so nothing may be throttled — otherwise a
    // transient Expo outage would lock the operator out for 24h.
    expect(sink.updates).toHaveLength(0)
  })

  it('ignores an inactive/unknown profile id rather than trusting it', async () => {
    createServerClient.mockReturnValue(makeDb(FLEET))
    const json = await (await POST(req({
      profile_ids: ['99999999-9999-9999-9999-999999999999'],
    }))).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(json.data).toEqual({ sent: 0, skipped_throttled: 0, skipped_no_token: 0 })
  })

  it('500s when the fleet read errors', async () => {
    createServerClient.mockReturnValue({
      from: () => ({
        select: function () { return this },
        eq: function () { return this },
        order: function () { return this },
        range: function () { return this },
        then: (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve),
      }),
    })
    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(500)
  })
})
