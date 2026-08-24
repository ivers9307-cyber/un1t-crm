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
// the route's correctness) can be asserted, and captures each update
// patch + the ids it was scoped to.
//
// The claim UPDATE is modelled FAITHFULLY rather than stubbed: it
// applies the `.in()` id list AND the `.or(...is.null,...lt.<cutoff>)`
// throttle filter against the fixture rows, returns only the rows that
// matched, and WRITES THE PATCH BACK into the fixture. That last part is
// what lets a second POST against the same db observe the first one's
// claim — i.e. it actually exercises the concurrency property instead of
// asserting a mock's opinion of it.
function makeDb(tables, sink = {}) {
  sink.calls = sink.calls || []
  sink.updates = sink.updates || []
  return {
    from(table) {
      let patch = null
      let ids = null
      let orFilter = null
      const claimable = (row) => {
        if (!orFilter) return true
        const cutoff = orFilter.match(/lt\.([^,)]+)/)?.[1]
        const value = row.last_update_nudge_at
        if (value == null) return true
        return cutoff ? Date.parse(value) < Date.parse(cutoff) : false
      }
      const matched = () =>
        (tables[table] ?? []).filter((row) => ids?.includes(row.id) && claimable(row))
      const builder = {
        select: (cols) => {
          sink.calls.push(['select', table, cols])
          if (patch) {
            // An update…select() returns the affected rows. Apply the
            // patch to the fixture so a later call sees the new state.
            const rows = matched()
            for (const row of rows) Object.assign(row, patch)
            sink.updates.push({ table, patch: { ...patch }, ids, returned: rows.map((r) => r.id) })
            return { then: (resolve) => Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(resolve) }
          }
          return builder
        },
        update: (row) => { patch = row; return builder },
        eq: (col, val) => { sink.calls.push(['eq', table, col, val]); return builder },
        order: (col, opts) => { sink.calls.push(['order', table, col, opts?.ascending]); return builder },
        range: (from, to) => { sink.calls.push(['range', table, from, to]); return builder },
        or: (expr) => { orFilter = expr; sink.calls.push(['or', table, expr]); return builder },
        in: (col, vals) => {
          sink.calls.push(['in', table, col, vals])
          ids = vals
          return builder
        },
        then: (resolve) => {
          if (patch) {
            // A bare update with no .select() — the claim RELEASE path.
            const rows = matched()
            for (const row of rows) Object.assign(row, patch)
            sink.updates.push({ table, patch: { ...patch }, ids, returned: rows.map((r) => r.id) })
            return Promise.resolve({ data: null, error: null }).then(resolve)
          }
          return Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve)
        },
      }
      return builder
    },
  }
}

// Fresh, mutable copy of the fixture — the mock writes claims back into
// it, so each test needs its own.
const fleet = (overrides = {}) => ({
  profiles: FLEET.profiles.map((p) => ({ ...p })),
  device_tokens: (overrides.device_tokens || FLEET.device_tokens).map((d) => ({ ...d })),
})

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
  // ANDROID-VIS.1 (mig 565) — expo_push_token is on every fixture row
  // because a nudge IS a push: since a device row no longer implies a
  // token, "outdated" and "reachable" became different questions. The
  // token-less case has its own describe block at the bottom.
  device_tokens: [
    {
      id: 'd-outdated', user_id: ID.outdated, app_version: '2.1.0',
      last_seen_at: daysAgo(1), last_update_nudge_at: null,
      expo_push_token: 'ExponentPushToken[outdated]',
    },
    {
      id: 'd-current', user_id: ID.current, app_version: '2.2.0',
      last_seen_at: daysAgo(0), last_update_nudge_at: null,
      expo_push_token: 'ExponentPushToken[current]',
    },
    {
      id: 'd-throttled', user_id: ID.throttled, app_version: '2.1.0',
      last_seen_at: daysAgo(2), last_update_nudge_at: hoursAgo(1),
      expo_push_token: 'ExponentPushToken[throttled]',
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
    createServerClient.mockReturnValue(makeDb(fleet(), sink))

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
    createServerClient.mockReturnValue(makeDb(fleet()))
    const json = await (await POST(req({ profile_ids: [ID.throttled] }))).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(json.data).toEqual({ sent: 0, skipped_throttled: 1, skipped_no_token: 0 })
  })

  it('nudges again once the throttle window has passed', async () => {
    createServerClient.mockReturnValue(makeDb(fleet({
      device_tokens: [
        FLEET.device_tokens[0],
        FLEET.device_tokens[1],
        { ...FLEET.device_tokens[2], last_update_nudge_at: daysAgo(2) },
      ],
    })))
    const json = await (await POST(req({ profile_ids: [ID.throttled] }))).json()
    expect(sendPush.mock.calls[0][0]).toEqual([ID.throttled])
    expect(json.data.sent).toBe(1)
  })

  it('CLAIMS the throttle before sending, conditionally, on the current device row', async () => {
    const sink = {}
    createServerClient.mockReturnValue(makeDb(fleet(), sink))
    await POST(req({ profile_ids: allIds }))

    // Exactly one write: the claim. It is scoped to the outdated
    // staffer's CURRENT device row — never the up-to-date one — and it
    // carries the conditional filter that makes it a claim rather than a
    // blind stamp. Without the .or(), two concurrent callers would both
    // read "not nudged" and both send.
    expect(sink.updates).toHaveLength(1)
    const [claim] = sink.updates
    expect(claim.table).toBe('device_tokens')
    expect(claim.ids).toContain('d-outdated')
    expect(claim.ids).not.toContain('d-current')
    expect(typeof claim.patch.last_update_nudge_at).toBe('string')

    const or = sink.calls.find(c => c[0] === 'or' && c[1] === 'device_tokens')?.[2]
    expect(or).toContain('last_update_nudge_at.is.null')
    expect(or).toContain('last_update_nudge_at.lt.')
    // The claim must be written BEFORE the push goes out, not after.
    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('a concurrent second call sends to nobody — the claim is the throttle', async () => {
    // Both calls run against the SAME rows, as two racing requests would.
    // The first claims d-outdated; the second finds nothing left to claim
    // and must send to no one rather than firing a duplicate push.
    const db = makeDb(fleet())
    createServerClient.mockReturnValue(db)

    const first = await (await POST(req({ profile_ids: allIds }))).json()
    expect(first.data.sent).toBe(1)
    expect(sendPush).toHaveBeenCalledTimes(1)

    const second = await (await POST(req({ profile_ids: allIds }))).json()
    expect(sendPush).toHaveBeenCalledTimes(1) // no second push
    expect(second.data.sent).toBe(0)
    expect(second.data.skipped_throttled).toBe(2)
  })

  it('uses the default copy, and lets a custom message override the body', async () => {
    createServerClient.mockReturnValue(makeDb(fleet()))
    await POST(req({ profile_ids: [ID.outdated] }))
    const defaultBody = sendPush.mock.calls[0][1].body
    expect(defaultBody).toMatch(/update/i)

    vi.clearAllMocks()
    hasPermission.mockReturnValue(true)
    getCurrentUser.mockResolvedValue(settingsUser)
    sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
    createServerClient.mockReturnValue(makeDb(fleet()))
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
    createServerClient.mockReturnValue(makeDb(fleet()))
    await POST(req({ profile_ids: [ID.outdated] }))
    expect(sendPush.mock.calls[0][1].category).toBeUndefined()
  })

  it('400s on a message longer than 200 characters', async () => {
    createServerClient.mockReturnValue(makeDb(fleet()))
    const res = await POST(req({ profile_ids: [ID.outdated], message: 'x'.repeat(201) }))
    expect(res.status).toBe(400)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('400s on a non-uuid profile id', async () => {
    createServerClient.mockReturnValue(makeDb(fleet()))
    const res = await POST(req({ profile_ids: ['not-a-uuid'] }))
    expect(res.status).toBe(400)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('reports a push failure in the counts instead of 500ing', async () => {
    const sink = {}
    createServerClient.mockReturnValue(makeDb(fleet(), sink))
    sendPush.mockRejectedValue(new Error('expo down'))

    const res = await POST(req({ profile_ids: allIds }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.sent).toBe(0)
    // Nothing was delivered, so the claim must be RELEASED — otherwise a
    // transient Expo outage would lock the operator out for 24h. The
    // release restores the value the row actually held (here: null), it
    // doesn't blanket-null rows that had an older genuine stamp.
    expect(sink.updates).toHaveLength(2)
    const [claim, release] = sink.updates
    expect(typeof claim.patch.last_update_nudge_at).toBe('string')
    expect(release.patch.last_update_nudge_at).toBeNull()
    expect(release.ids).toEqual(['d-outdated'])
  })

  it('releases the claim when the push pipeline delivers nothing', async () => {
    // Distinct from a throw: sendPush resolves, but every ticket failed.
    const sink = {}
    createServerClient.mockReturnValue(makeDb(fleet(), sink))
    sendPush.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 1 })

    const json = await (await POST(req({ profile_ids: [ID.outdated] }))).json()
    expect(json.data.sent).toBe(0)
    expect(sink.updates).toHaveLength(2)
    expect(sink.updates[1].patch.last_update_nudge_at).toBeNull()
  })

  it('500s rather than sending when the claim itself fails', async () => {
    // A failed claim means the throttle isn't holding, so sending anyway
    // could double-push. Failing is the safe direction — the operator
    // just retries.
    createServerClient.mockReturnValue({
      from: (table) => {
        let patch = null
        const builder = {
          select: () => (patch
            ? { then: (r) => Promise.resolve({ data: null, error: { message: 'claim boom' } }).then(r) }
            : builder),
          update: (row) => { patch = row; return builder },
          eq: () => builder,
          order: () => builder,
          range: () => builder,
          or: () => builder,
          in: () => builder,
          then: (resolve) => Promise.resolve({
            data: table === 'profiles' ? FLEET.profiles : FLEET.device_tokens,
            error: null,
          }).then(resolve),
        }
        return builder
      },
    })

    const res = await POST(req({ profile_ids: [ID.outdated] }))
    expect(res.status).toBe(500)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('ignores an inactive/unknown profile id rather than trusting it', async () => {
    createServerClient.mockReturnValue(makeDb(fleet()))
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

describe('POST /api/staff-devices/nudge — ANDROID-VIS.1 token-less devices (mig 565)', () => {
  it('counts an outdated staffer with no push token as skipped_no_token, and claims nothing', async () => {
    // An Android device is visible in the fleet report now but still
    // unreachable until FCM credentials exist. Nudging it would burn the
    // 24h throttle on a push that can never land.
    createServerClient.mockReturnValue(makeDb(fleet({
      device_tokens: [
        { ...FLEET.device_tokens[0], expo_push_token: null },
        // Establishes the target build, so the row above really is behind.
        FLEET.device_tokens[1],
      ],
    })))
    const json = await (await POST(req({ profile_ids: [ID.outdated] }))).json()
    expect(sendPush).not.toHaveBeenCalled()
    expect(json.data).toEqual({ sent: 0, skipped_throttled: 0, skipped_no_token: 1 })
  })

  it('STILL nudges someone whose newest device is token-less but who has another that is not', async () => {
    // sendPush fans out across ALL of a person's tokens, so reachability
    // is a property of the person, not of their most recently seen row.
    // Judging it on currentDevice() would silently stop nudging an iPhone
    // user the moment they also signed in on Android.
    createServerClient.mockReturnValue(makeDb(fleet({
      device_tokens: [
        FLEET.device_tokens[0],
        // Someone else on the target build, so 2.1.0 really is behind.
        FLEET.device_tokens[1],
        {
          id: 'd-outdated-android', user_id: ID.outdated, app_version: '2.1.0',
          last_seen_at: daysAgo(0), last_update_nudge_at: null,
          expo_push_token: null,
        },
      ],
    })))
    const json = await (await POST(req({ profile_ids: [ID.outdated] }))).json()
    expect(sendPush.mock.calls[0][0]).toEqual([ID.outdated])
    expect(json.data.sent).toBe(1)
  })

  it('a token-less device still counts towards the fleet target version', async () => {
    // The point of making it visible: an Android staffer on the newest
    // build should be able to show everyone else up as outdated.
    createServerClient.mockReturnValue(makeDb(fleet({
      device_tokens: [
        FLEET.device_tokens[0],
        {
          id: 'd-android-newest', user_id: ID.current, app_version: '2.9.0',
          last_seen_at: daysAgo(0), last_update_nudge_at: null,
          expo_push_token: null,
        },
      ],
    })))
    const json = await (await POST(req({ profile_ids: [ID.outdated] }))).json()
    // 2.1.0 is behind the 2.9.0 the Android device reported.
    expect(json.data.sent).toBe(1)
  })
})
