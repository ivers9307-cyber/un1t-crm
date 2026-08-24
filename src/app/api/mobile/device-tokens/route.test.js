// Coverage for POST /api/mobile/device-tokens — the device registration
// endpoint. The app_version cases matter beyond input hygiene: whatever
// lands in that column is what STAFF-DEV's deriveTargetVersion() measures
// the whole fleet against, so a device must not be able to claim an
// arbitrarily high version.
//
// ANDROID-VIS.1 (mig 565) adds the dual-identity cases at the bottom: the
// route now keys on `device_key` when the client sends one, adopts the
// pre-565 token-keyed rows into a key, and accepts a registration with no
// push token at all.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST, DELETE } = await import('./route.js')

const TOKEN = 'ExponentPushToken[abcdef123456]'
const DEVICE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

// Captures the upserted row (and the pre-upsert identity statements) so
// assertions can read what was written and with what conflict target.
//
// ANDROID-VIS.1b — `plan` injects DB ERRORS. The original fake always
// answered success, which is exactly why a 42P10 on every device_key upsert
// (mig 565's partial index, unfixable by ON CONFLICT inference) was
// invisible to a green suite. A fake that cannot fail cannot prove a
// failure is handled.
function makeDb(captured, plan = {}) {
  captured.updates = []
  captured.deletes = []
  captured.onConflict = undefined

  const chain = (record, result) => {
    const self = {
      eq(col, val) { record.filters.push(['eq', col, val]); return self },
      is(col, val) { record.filters.push(['is', col, val]); return self },
      not(col, op, val) { record.filters.push(['not', col, op, val]); return self },
      neq(col, val) { record.filters.push(['neq', col, val]); return self },
      // supabase-js builders are thenables, not Promises.
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
    }
    return self
  }

  return {
    from: () => ({
      upsert(row, opts) {
        captured.row = row
        captured.onConflict = opts?.onConflict
        return {
          select: () => ({
            single: () => Promise.resolve(
              plan.upsertError
                ? { data: null, error: plan.upsertError }
                : { data: { id: 'dt-1' }, error: null }
            ),
          }),
        }
      },
      update(patch) {
        const record = { patch, filters: [] }
        captured.updates.push(record)
        // Discriminated by PATCH, not call order — the two statements do
        // different things and a test that swapped them should fail loudly.
        const error = 'device_key' in patch ? plan.adoptError : plan.releaseError
        return chain(record, () => ({ data: null, error: error ?? null }))
      },
      delete() {
        const record = { filters: [] }
        captured.deletes.push(record)
        return chain(record, () => ({ data: null, error: plan.pruneError ?? null }))
      },
    }),
  }
}

/** Postgres unique_violation — what an ADOPT collides with. */
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' }

const del = (body) =>
  new Request('http://localhost/api/mobile/device-tokens', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const req = (body) =>
  new Request('http://localhost/api/mobile/device-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/mobile/device-tokens', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ expo_push_token: TOKEN }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('registers a device with a well-formed app_version', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({
      expo_push_token: TOKEN, platform: 'ios',
      device_name: 'iPhone 15', app_version: '2.2.0',
    }))
    expect(res.status).toBe(200)
    expect(captured.row.app_version).toBe('2.2.0')
    expect(captured.row.user_id).toBe('u1')
  })

  it('400s on a malformed app_version instead of storing it', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    for (const bad of ['9'.repeat(40), '99999.0.0', 'not-a-version', '2.2.0; DROP', '']) {
      const res = await POST(req({ expo_push_token: TOKEN, app_version: bad }))
      expect(res.status, `expected 400 for ${JSON.stringify(bad)}`).toBe(400)
    }
    expect(captured.row).toBeUndefined()
  })

  it('still accepts a register with no app_version at all (old clients)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({ expo_push_token: TOKEN }))
    expect(res.status).toBe(200)
    expect(captured.row.app_version).toBeUndefined()
  })

  it('persists geofence_permission (+ a timestamp) when the client sends one', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({
      expo_push_token: TOKEN, geofence_permission: 'always',
    }))
    expect(res.status).toBe(200)
    expect(captured.row.geofence_permission).toBe('always')
    expect(typeof captured.row.geofence_permission_at).toBe('string')
  })

  it('OMITS the geofence keys entirely when the client sends none', async () => {
    // Load-bearing: the conflict target is expo_push_token, so an upsert
    // writes the WHOLE row — including a key present-but-undefined. If
    // these keys were in the patch, every register from a pre-2.2.0
    // client would wipe a permission we had already learned, and
    // "never reported" would be indistinguishable from "denied".
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({ expo_push_token: TOKEN, app_version: '2.1.0' }))
    expect(res.status).toBe(200)
    expect(Object.keys(captured.row)).not.toContain('geofence_permission')
    expect(Object.keys(captured.row)).not.toContain('geofence_permission_at')
  })

  it('400s on a geofence_permission outside the mig 466 CHECK values', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({ expo_push_token: TOKEN, geofence_permission: 'maybe' }))
    expect(res.status).toBe(400)
    expect(captured.row).toBeUndefined()
  })
})

// --- ANDROID-VIS.1 (mig 565) — dual identity -----------------------------

describe('POST /api/mobile/device-tokens — device_key identity', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue({ id: 'u1' }))

  it('registers a device that could NOT obtain a push token', async () => {
    // The whole point: this is every Android device today. Before mig 565
    // the schema refused the row (expo_push_token NOT NULL), the client
    // never even attempted it, and the device was invisible in the fleet
    // report as well as unreachable by push.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({
      device_key: DEVICE_KEY,
      platform: 'android',
      device_name: 'Pixel 8',
      app_version: '2.3.0',
      geofence_permission: 'always',
    }))

    expect(res.status).toBe(200)
    expect(captured.onConflict).toBe('device_key')
    expect(captured.row.device_key).toBe(DEVICE_KEY)
    expect(captured.row.platform).toBe('android')
    expect(captured.row.app_version).toBe('2.3.0')
    expect(captured.row.geofence_permission).toBe('always')
    // Never written as an explicit null: on a re-report from a device that
    // DOES have a token, that would silence a working phone.
    expect(Object.keys(captured.row)).not.toContain('expo_push_token')
  })

  it('400s when the client offers NEITHER identity', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))
    const res = await POST(req({ platform: 'android', app_version: '2.3.0' }))
    expect(res.status).toBe(400)
    expect(captured.row).toBeUndefined()
  })

  it('400s on a device_key that is not 32 lowercase hex', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))
    for (const bad of ['A'.repeat(32), 'z'.repeat(32), 'ab', `${DEVICE_KEY}0`, '']) {
      const res = await POST(req({ device_key: bad }))
      expect(res.status, `expected 400 for ${JSON.stringify(bad)}`).toBe(400)
    }
    expect(captured.row).toBeUndefined()
  })

  it('keys on the token, not the key, for a client that only sends a token', async () => {
    // The 13 live iOS rows and every pre-2.3.x client. Unchanged path.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({ expo_push_token: TOKEN, platform: 'ios' }))
    expect(res.status).toBe(200)
    expect(captured.onConflict).toBe('expo_push_token')
    expect(captured.row.expo_push_token).toBe(TOKEN)
    // Nothing to adopt or release without a key on the wire.
    expect(captured.updates).toHaveLength(0)
  })

  it('ADOPTS the pre-565 row before upserting, so the iOS history survives', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({
      expo_push_token: TOKEN, device_key: DEVICE_KEY, platform: 'ios',
    }))
    expect(res.status).toBe(200)

    const [adopt, release] = captured.updates
    expect(adopt.patch).toEqual({ device_key: DEVICE_KEY })
    expect(adopt.filters).toEqual([
      ['eq', 'expo_push_token', TOKEN],
      // Only a row that has NO key yet — never one already claimed by
      // another install.
      ['is', 'device_key', null],
    ])

    // And the token is released from any row holding it under a DIFFERENT,
    // NON-NULL key, so the surviving unique index on expo_push_token cannot
    // turn a routine report into a 500 — without nulling the token on a
    // key-less row, which would leave no identity and trip mig 565's CHECK.
    expect(release.patch).toEqual({ expo_push_token: null })
    expect(release.filters).toEqual([
      ['eq', 'expo_push_token', TOKEN],
      ['not', 'device_key', 'is', null],
      ['neq', 'device_key', DEVICE_KEY],
    ])

    // The upsert itself still keys on the NEW identity.
    expect(captured.onConflict).toBe('device_key')
    expect(captured.row.expo_push_token).toBe(TOKEN)
    expect(captured.row.device_key).toBe(DEVICE_KEY)
  })

  it('runs no identity statements when the client has no token to reconcile', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))
    await POST(req({ device_key: DEVICE_KEY, platform: 'android' }))
    expect(captured.updates).toHaveLength(0)
  })

  it('accepts an explicit null token from a client whose token attempt failed', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))
    const res = await POST(req({
      expo_push_token: null, device_key: DEVICE_KEY, platform: 'android',
    }))
    expect(res.status).toBe(200)
    expect(Object.keys(captured.row)).not.toContain('expo_push_token')
  })
})

describe('DELETE /api/mobile/device-tokens — deregistering by either identity', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue({ id: 'u1' }))

  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await DELETE(del({ expo_push_token: TOKEN }))
    expect(res.status).toBe(401)
  })

  it('deletes a token-less device by its key, always scoped to the caller', async () => {
    // Without this a signed-out Android device keeps naming the leaver as
    // its owner in the fleet report.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await DELETE(del({ device_key: DEVICE_KEY }))
    expect(res.status).toBe(200)
    expect(captured.deletes[0].filters).toEqual([
      ['eq', 'user_id', 'u1'],
      ['eq', 'device_key', DEVICE_KEY],
    ])
  })

  it('prefers the key when both identities are sent — the token may have rotated', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    await DELETE(del({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))
    expect(captured.deletes[0].filters).toEqual([
      ['eq', 'user_id', 'u1'],
      ['eq', 'device_key', DEVICE_KEY],
    ])
  })

  it('still deletes by token for an older client', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    await DELETE(del({ expo_push_token: TOKEN }))
    expect(captured.deletes[0].filters).toEqual([
      ['eq', 'user_id', 'u1'],
      ['eq', 'expo_push_token', TOKEN],
    ])
  })

  it('400s when neither identity is supplied', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))
    const res = await DELETE(del({}))
    expect(res.status).toBe(400)
    expect(captured.deletes).toHaveLength(0)
  })
})

// --- ANDROID-VIS.1b — review fixes ---------------------------------------

describe('POST /api/mobile/device-tokens — DB failures actually surface', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue({ id: 'u1' }))

  it('500s when the upsert itself fails', async () => {
    // Regression guard for the mig 565 ship-stopper: ON CONFLICT (device_key)
    // could not infer a PARTIAL unique index, so every device_key upsert
    // returned 42P10. The suite stayed green because the fake could not
    // fail. Mig 566 makes the index full; this test makes the failure mode
    // visible if anything ever re-partials it.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured, {
      upsertError: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' },
    }))

    const res = await POST(req({ device_key: DEVICE_KEY, platform: 'android' }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('500s rather than upserting when ADOPT fails for an unexpected reason', async () => {
    // The discarded-error class: the first cut logged the adopt error and
    // walked into an upsert that was already doomed, so the 500 named the
    // wrong stage and the real cause only existed in a log line.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured, {
      adoptError: { code: '08006', message: 'connection failure' },
    }))

    const res = await POST(req({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))
    expect(res.status).toBe(500)
    expect(captured.row).toBeUndefined()
  })

  it('500s rather than upserting when RELEASE fails', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured, {
      releaseError: { code: '08006', message: 'connection failure' },
    }))

    const res = await POST(req({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))
    expect(res.status).toBe(500)
    expect(captured.row).toBeUndefined()
  })
})

describe('POST /api/mobile/device-tokens — the permanent-500 interleaving', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue({ id: 'u1' }))

  it('prunes the superseded token row when ADOPT hits a unique violation', async () => {
    // The interleaving, in full:
    //   1. Device reports token-less (permission declined / no FCM) →
    //      INSERT R2(device_key=K, expo_push_token=NULL).
    //   2. Its pre-565 row R1(expo_push_token=T, device_key=NULL) is still
    //      there from before the migration.
    //   3. Token arrives. ADOPT tries to stamp K onto R1 → unique violation
    //      against R2's key. The first cut swallowed it, RELEASE could not
    //      see R1 (`<>` is not-true for NULL), and the upsert then violated
    //      the surviving token index — 500 on EVERY report, forever.
    // R1 is the same install as R2, superseded. Delete it.
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured, { adoptError: UNIQUE_VIOLATION }))

    const res = await POST(req({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))
    expect(res.status).toBe(200)

    expect(captured.deletes).toHaveLength(1)
    expect(captured.deletes[0].filters).toEqual([
      ['eq', 'expo_push_token', TOKEN],
      ['is', 'device_key', null],
    ])
    // And the report still lands, on the device_key identity.
    expect(captured.onConflict).toBe('device_key')
    expect(captured.row.expo_push_token).toBe(TOKEN)
  })

  it('500s when the prune fails, rather than walking into the doomed upsert', async () => {
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured, {
      adoptError: UNIQUE_VIOLATION,
      pruneError: { code: '08006', message: 'connection failure' },
    }))

    const res = await POST(req({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))
    expect(res.status).toBe(500)
    expect(captured.row).toBeUndefined()
  })

  it('RELEASE never touches a NULL-device_key row — that would trip the CHECK', async () => {
    // mig 565's device_tokens_identity_present CHECK (verified VALIDATED in
    // prod) refuses a row with neither identity. Nulling the token on a
    // key-less row would leave exactly that, so the review's suggested
    // `device_key IS DISTINCT FROM` release would have traded a 500 for a
    // CHECK violation. RELEASE is scoped to rows that KEEP an identity;
    // key-less ones are handled by ADOPT (or the prune above).
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    await POST(req({ expo_push_token: TOKEN, device_key: DEVICE_KEY }))

    const release = captured.updates.find(u => 'expo_push_token' in u.patch)
    expect(release.patch).toEqual({ expo_push_token: null })
    expect(release.filters).toEqual([
      ['eq', 'expo_push_token', TOKEN],
      ['not', 'device_key', 'is', null],
      ['neq', 'device_key', DEVICE_KEY],
    ])
  })
})
