// Coverage for POST /api/admin/push/test — the "send one push to this
// user's phone and tell me what happened" button on the staff editor.
//
// The one thing worth pinning here is that the test push actually
// REACHES an ordinary staff member. This route is the tool you reach for
// when push is already suspected broken, so a diagnostic that silently
// suppresses itself is worse than no diagnostic at all: it reports
// "sent: 0, skipped: 1" and you go hunting for a device problem that
// isn't there.
//
// It regressed exactly that way once. The route sent `category: 'test'`
// on the belief that an unregistered category is "no opinion". It is
// not: sendPush gates a categorised push on notify_<category>, and
// resolvePermission's last tier is `defaults[role][key] === true`, so an
// unregistered key resolves to FALSE for every role except master. The
// button therefore worked when a master tested it on themselves and
// suppressed itself for everyone else — see STAFF-DEV.8, which hit the
// same trap with `app_update`.
//
// So these tests deliberately run the REAL sendPush + the real
// permission resolver over a fake DB rather than asserting on a mocked
// sendPush's arguments. Asserting "called without a category" would pin
// today's fix; asserting "the staffer was not skipped" pins the
// behaviour we actually care about, and would still fail if the gating
// tiers moved underneath us.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => makeFakeDb() }))

const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

// uuidLike-shaped — 'p1' would 400 at the schema.
const MASTER = '11111111-1111-1111-1111-111111111111'
const STAFF = '22222222-2222-2222-2222-222222222222'
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

let fakeProfiles = []
let fakeLinks = []
let fakeTemplates = []
let fakeTokens = []

// Serves both shapes in play: the route's own
// profiles.select().eq().maybeSingle() lookup of the recipient, and
// push.js's .select().in() fan-out reads.
function makeFakeDb() {
  const rowsFor = (table) => ({
    profiles: fakeProfiles,
    profile_locations: fakeLinks,
    location_role_permissions: fakeTemplates,
    device_tokens: fakeTokens,
  })[table] || []

  function from(table) {
    let rows = rowsFor(table)
    const builder = {
      select: () => builder,
      delete: () => builder,
      // ANDROID-VIS.1 (mig 565) — push.js filters out device rows with a
      // NULL expo_push_token. Modelled, not ignored, so a regression in
      // that filter shows up here too.
      not: (col, op, val) => {
        if (op === 'is' && val === null) rows = rows.filter(r => r[col] != null)
        return builder
      },
      eq: (col, val) => {
        const matched = rows.filter(r => r[col] === val)
        return {
          maybeSingle: () => Promise.resolve({ data: matched[0] ?? null, error: null }),
          then: (resolve) => Promise.resolve({ data: matched, error: null }).then(resolve),
        }
      },
      in: (col, vals) => Promise.resolve({
        data: rows.filter(r => vals.includes(r[col])),
        error: null,
      }),
      then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
    }
    return builder
  }
  return { from }
}

const req = (body) =>
  new Request('http://localhost/api/admin/push/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  getCurrentUser.mockResolvedValue({
    id: MASTER, role: 'master', isMaster: true, full_name: 'Admin', email: 'a@x.ie',
  })
  // A plain staff member with a phone: active, no per-user permission
  // overrides at all (the common case — most staff never touch the
  // notification toggles, so their blob is empty and every key resolves
  // through the role tiers).
  fakeProfiles = [{ id: STAFF, full_name: 'Coach', active: true, employment_type: null }]
  fakeLinks = [{ profile_id: STAFF, location_id: LOCATION, role: 'staff', permissions: null }]
  fakeTemplates = []
  fakeTokens = [{ id: 'd1', user_id: STAFF, expo_push_token: 'ExponentPushToken[x]' }]
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  })
})

describe('POST /api/admin/push/test', () => {
  it('actually delivers to a non-master staff member with no permission overrides', async () => {
    const res = await POST(req({ recipient_id: STAFF }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    // The regression: `skipped: 1, sent: 0` here means the push was
    // gated out before Expo was ever called.
    expect(json.data).toMatchObject({ sent: 1, skipped: 0 })
    expect(global.fetch).toHaveBeenCalled()
  })

  it('still honours the master push_notifications switch', async () => {
    // The test push is a diagnostic, not a preference — but "I turned
    // push off" is a real answer to "why didn't it arrive", so the
    // master switch must keep gating it.
    fakeLinks = [{
      profile_id: STAFF, location_id: LOCATION, role: 'staff',
      permissions: { mobile: { push_notifications: false } },
    }]

    const res = await POST(req({ recipient_id: STAFF }))
    const json = await res.json()

    expect(json.data).toMatchObject({ sent: 0, skipped: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects a non-admin caller', async () => {
    getCurrentUser.mockResolvedValue({ id: STAFF, role: 'staff', isMaster: false })
    const res = await POST(req({ recipient_id: STAFF }))
    expect(res.status).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('404s an unknown recipient', async () => {
    const res = await POST(req({ recipient_id: '33333333-3333-3333-3333-333333333333' }))
    expect(res.status).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
