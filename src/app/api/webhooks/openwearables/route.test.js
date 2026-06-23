// Route-level tests for the Open Wearables webhook receiver (WEARABLE-INGEST
// IB5) — the inbound seam that turns an OW workout.created event into a
// heart_rate_sessions row.
//
// Two layers:
//   1. verifyOpenWearablesSignature() — the PURE Svix-signature predicate
//      (the security boundary). Valid sig passes; tampered body, stale
//      timestamp, missing secret, missing headers all fail.
//   2. POST() — the orchestration contract: bad/missing sig → 401; an
//      unknown OW user → 200 with NO insert; a re-delivered workout →
//      no duplicate insert; a fresh workout → maps + inserts source
//      'apple_health' + calls finalizeSessionRewards.
//
// The OW client + Supabase + the reward cascade are mocked so each test
// exercises one path. Nothing hits the live OW server.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/openwearables', () => ({ createOpenWearablesClient: vi.fn() }))
vi.mock('@/lib/live-class', () => ({ finalizeSessionRewards: vi.fn(async () => {}) }))
// class-occurrences / class-bookings are real (pure) — but the handler only
// reaches resolveCurrentOccurrence via the DB mock, which returns no
// occurrences, so class-correlation is naturally skipped unless a test
// arranges otherwise. Mock them to keep the default path deterministic.
vi.mock('@/lib/class-occurrences', () => ({ resolveCurrentOccurrence: vi.fn(async () => null) }))
vi.mock('@/lib/class-bookings', () => ({ lookupBookedMember: vi.fn(async () => false) }))

import { POST, verifyOpenWearablesSignature, extractWorkoutRef } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { createOpenWearablesClient } from '@/lib/openwearables'
import { finalizeSessionRewards } from '@/lib/live-class'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'

const SECRET = 'whsec_' + Buffer.from('super-secret-signing-key-1234567').toString('base64')

// Build a valid Svix signature for a given body, the way OW/Svix would.
function signSvix({ svixId, svixTimestamp, rawBody, secret = SECRET }) {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  const key = Buffer.from(raw, 'base64')
  const sig = crypto
    .createHmac('sha256', key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`, 'utf8')
    .digest('base64')
  return `v1,${sig}`
}

function makeRequest({ body, svixId = 'msg_1', svixTimestamp, signature } = {}) {
  const ts = svixTimestamp ?? String(Math.floor(Date.now() / 1000))
  const sig = signature ?? signSvix({ svixId, svixTimestamp: ts, rawBody: body })
  const headers = {
    'svix-id': svixId,
    'svix-timestamp': ts,
    'svix-signature': sig,
  }
  return {
    text: async () => body,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  }
}

// The full Apple workout, exactly as it arrives IN the webhook payload's
// `data`. OW is PUSH-ONLY for Apple (no workout-detail API — the fetch-back
// raises NotImplementedError), so the handler maps this directly and never
// calls getWorkout for apple_health.
const WORKOUT = {
  id: 'wk-123',
  user_id: 'ow-user-42',
  type: 'functional_strength_training',
  start_time: '2026-06-20T10:00:00Z',
  end_time: '2026-06-20T10:45:00Z',
  avg_heart_rate_bpm: 140,
  max_heart_rate_bpm: 175,
  calories_kcal: 320,
  distance_meters: 1200,
  avg_pace_sec_per_km: 300,
  source: { provider: 'apple', device: 'Apple Watch' },
}

// Svix Cloud delivers the message payload AS the raw body: `{ type, data }`
// (no `payload` wrapper; provider nested at data.source.provider).
const WORKOUT_BODY = JSON.stringify({ type: 'workout.created', data: WORKOUT })

// In-memory Supabase mock. Per-table queued responses + records inserts.
function makeDb({ connection, contact, location, existingWorkout, richer } = {}) {
  const inserts = []
  function from(table) {
    const b = { _table: table, _op: 'select', _payload: null }
    b.select = () => b
    b.insert = (payload) => { b._op = 'insert'; b._payload = payload; return b }
    b.update = () => b
    b.eq = () => b
    b.neq = () => b
    b.filter = () => b
    b.limit = () => b
    b.maybeSingle = () => {
      if (table === 'hr_provider_connections') return Promise.resolve({ data: connection ?? null })
      if (table === 'contacts') return Promise.resolve({ data: contact ?? null })
      if (table === 'locations') return Promise.resolve({ data: location ?? null })
      if (table === 'heart_rate_sessions') {
        // Two distinct reads use maybeSingle: workout-dedup then richer-
        // session. Distinguish by which guard data is present.
        if (b._dedupKind === 'richer') return Promise.resolve({ data: richer ?? null })
        return Promise.resolve({ data: existingWorkout ?? null })
      }
      return Promise.resolve({ data: null })
    }
    // The workout-dedup read uses .filter(); tag it so maybeSingle returns
    // the right fixture. The richer-session read uses .neq().
    const origFilter = b.filter
    b.filter = (...args) => { b._dedupKind = 'workout'; return origFilter.apply(b, args) }
    const origNeq = b.neq
    b.neq = (...args) => { b._dedupKind = 'richer'; return origNeq.apply(b, args) }
    b.single = () => {
      if (b._op === 'insert') {
        inserts.push({ table, payload: b._payload })
        return Promise.resolve({ data: { id: 'sess-new' }, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }
    return b
  }
  return { from, _inserts: inserts }
}

let getWorkoutSpy
let getHrSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENWEARABLES_WEBHOOK_SECRET = SECRET
  resolveCurrentOccurrence.mockResolvedValue(null)
  // getWorkout should NEVER be called for apple_health (push-only) — it's
  // here only for the pull-provider path. getHeartRateTimeseries IS tried
  // for apple (tolerantly), defaulting to no samples.
  getWorkoutSpy = vi.fn(async () => WORKOUT)
  getHrSpy = vi.fn(async () => [])
  createOpenWearablesClient.mockReturnValue({
    getWorkout: getWorkoutSpy,
    getHeartRateTimeseries: getHrSpy,
  })
})

// ── Pure: verifyOpenWearablesSignature ───────────────────────────────
describe('verifyOpenWearablesSignature (pure Svix predicate)', () => {
  const svixId = 'msg_abc'
  const svixTimestamp = String(Math.floor(Date.now() / 1000))
  const rawBody = '{"hello":"world"}'

  it('accepts a correctly-signed request', () => {
    const sig = signSvix({ svixId, svixTimestamp, rawBody })
    const res = verifyOpenWearablesSignature({
      headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': sig },
      rawBody,
      secret: SECRET,
    })
    expect(res.ok).toBe(true)
  })

  it('accepts when one of several space-separated signatures matches (rotation)', () => {
    const good = signSvix({ svixId, svixTimestamp, rawBody })
    const header = `v1,deadbeef ${good}`
    const res = verifyOpenWearablesSignature({
      headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': header },
      rawBody,
      secret: SECRET,
    })
    expect(res.ok).toBe(true)
  })

  it('rejects a tampered body (signature no longer matches)', () => {
    const sig = signSvix({ svixId, svixTimestamp, rawBody })
    const res = verifyOpenWearablesSignature({
      headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': sig },
      rawBody: rawBody + 'tampered',
      secret: SECRET,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_matching_signature')
  })

  it('rejects a stale timestamp (> 5 min old)', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60)
    const sig = signSvix({ svixId, svixTimestamp: staleTs, rawBody })
    const res = verifyOpenWearablesSignature({
      headers: { 'svix-id': svixId, 'svix-timestamp': staleTs, 'svix-signature': sig },
      rawBody,
      secret: SECRET,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('timestamp_out_of_tolerance')
  })

  it('returns missing_secret when no secret is configured', () => {
    const res = verifyOpenWearablesSignature({ headers: {}, rawBody, secret: undefined })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing_secret')
  })

  it('returns missing_headers when a svix header is absent', () => {
    const res = verifyOpenWearablesSignature({
      headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp },
      rawBody,
      secret: SECRET,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing_headers')
  })

  it('reads headers via a Headers-like .get() interface too', () => {
    const sig = signSvix({ svixId, svixTimestamp, rawBody })
    const map = { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': sig }
    const res = verifyOpenWearablesSignature({
      headers: { get: (k) => map[k] ?? null },
      rawBody,
      secret: SECRET,
    })
    expect(res.ok).toBe(true)
  })
})

// ── Pure: extractWorkoutRef ──────────────────────────────────────────
describe('extractWorkoutRef', () => {
  it('pulls ids from the payload root', () => {
    expect(extractWorkoutRef({ provider: 'apple', user_id: 'u1', workout_id: 'w1' }))
      .toEqual({ provider: 'apple', userId: 'u1', workoutId: 'w1' })
  })
  it('tolerates a nested workout object + camelCase', () => {
    expect(extractWorkoutRef({ workout: { provider: 'apple', userId: 'u2', id: 'w2' } }))
      .toEqual({ provider: 'apple', userId: 'u2', workoutId: 'w2' })
  })
  it('pulls ids from a flat Svix Cloud body (data + source.provider)', () => {
    // Svix Cloud delivers the payload AS the body: { type, data: {...} },
    // provider nested at data.source.provider — no top-level provider, no
    // `payload` wrapper. The handler passes the whole message in (its
    // `payload` key is undefined), so all three ids must resolve here.
    expect(extractWorkoutRef({
      type: 'workout.created',
      data: { id: 'w3', user_id: 'u3', source: { provider: 'apple', name: 'Apple Watch' } },
    })).toEqual({ provider: 'apple', userId: 'u3', workoutId: 'w3' })
  })
  it('returns nulls when ids are absent', () => {
    expect(extractWorkoutRef({})).toEqual({ provider: null, userId: null, workoutId: null })
    expect(extractWorkoutRef(null)).toEqual({ provider: null, userId: null, workoutId: null })
  })
})

// ── Handler: POST ────────────────────────────────────────────────────
describe('POST /api/webhooks/openwearables', () => {
  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    const res = await POST(makeRequest({ body: WORKOUT_BODY, signature: 'v1,wrong' }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns 401 when the webhook secret is unconfigured (fail closed)', async () => {
    delete process.env.OPENWEARABLES_WEBHOOK_SECRET
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('ignores a non-workout event type with 200 and no DB work', async () => {
    const body = JSON.stringify({ id: 'm', eventType: 'sync.completed', timestamp: 't', payload: {} })
    const res = await POST(makeRequest({ body }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ignored).toBe('sync.completed')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('unknown OW user (no active connection) → 200, no insert', async () => {
    const db = makeDb({ connection: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.skipped).toBe('unknown_user')
    expect(db._inserts).toHaveLength(0)
    expect(finalizeSessionRewards).not.toHaveBeenCalled()
  })

  it('re-delivery (existing ow_workout_id) → 200, no duplicate insert', async () => {
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: { id: 'sess-old' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.deduped).toBe('workout_already_ingested')
    expect(db._inserts).toHaveLength(0)
    expect(finalizeSessionRewards).not.toHaveBeenCalled()
  })

  it('fresh workout → inserts source apple_health + calls finalizeSessionRewards', async () => {
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: 185, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: null,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.inserted).toBe('sess-new')
    expect(db._inserts).toHaveLength(1)
    const row = db._inserts[0].payload
    expect(row.source).toBe('apple_health')
    expect(row.contact_id).toBe('c-1')
    expect(row.location_id).toBe('loc-1')
    expect(row.max_hr_used).toBe(185)
    expect(row.raw_metadata.ow_workout_id).toBe('wk-123')
    // Workout detail (mig 306) mapped straight from the payload.
    expect(row.workout_type).toBe('functional_strength_training')
    expect(row.calories_kcal).toBe(320)
    expect(row.distance_meters).toBe(1200)
    expect(row.avg_pace_sec_per_km).toBe(300)
    // Apple maps the payload directly — getWorkout is NEVER called (the OW
    // detail endpoint raises NotImplementedError for apple); the timeseries
    // IS tried (tolerantly).
    expect(getWorkoutSpy).not.toHaveBeenCalled()
    expect(getHrSpy).toHaveBeenCalled()
    // No HR samples → no-HR path → avg/peak come from the payload aggregates.
    expect(row.avg_hr_bpm).toBe(140)
    expect(row.peak_hr_bpm).toBe(175)
    // No live class arranged → not class-linked.
    expect(json.classLinked).toBe(false)
    expect(finalizeSessionRewards).toHaveBeenCalledWith(db, 'sess-new', expect.objectContaining({ nowMs: expect.any(Number) }))
  })

  it('apple is push-only — maps the payload even when getWorkout would 500 (NotImplemented)', async () => {
    // The whole bug: IB5 used to call getWorkout for apple, which OW answers
    // with NotImplementedError ("Apple Health does not support API-based
    // workout detail fetching") → ow_fetch_failed, no session. The handler
    // must NOT call getWorkout for apple at all — prove it by making the spy
    // throw and asserting a session still lands.
    getWorkoutSpy.mockRejectedValue(new Error('NotImplementedError: Apple Health does not support API-based workout detail fetching'))
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: null,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.skipped).toBeUndefined()
    expect(json.inserted).toBe('sess-new')
    expect(getWorkoutSpy).not.toHaveBeenCalled()
    expect(db._inserts[0].payload.source).toBe('apple_health')
  })

  it('apple HR-timeseries failure is tolerated → still inserts via aggregates', async () => {
    // The timeseries endpoint may also be unavailable for apple; that must
    // NOT fail the session — fall back to the workout's avg/max aggregates.
    getHrSpy.mockRejectedValue(new Error('NotImplementedError'))
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: null,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.inserted).toBe('sess-new')
    expect(db._inserts[0].payload.avg_hr_bpm).toBe(140)
    expect(db._inserts[0].payload.peak_hr_bpm).toBe(175)
  })

  it('class-correlated fresh workout → stamps glofox_event_id + booked link', async () => {
    resolveCurrentOccurrence.mockResolvedValue({ glofox_event_id: 'gf-evt-9', class_name: 'HIIT 45' })
    const { lookupBookedMember } = await import('@/lib/class-bookings')
    lookupBookedMember.mockResolvedValue(true)
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: null,
      richer: null,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.classLinked).toBe(true)
    const row = db._inserts[0].payload
    expect(row.glofox_event_id).toBe('gf-evt-9')
    expect(row.class_name).toBe('HIIT 45')
    expect(row.class_link_source).toBe('booked')
  })

  it('strap session already owns the class slot → 200, no apple_health insert', async () => {
    resolveCurrentOccurrence.mockResolvedValue({ glofox_event_id: 'gf-evt-9', class_name: 'HIIT 45' })
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
      existingWorkout: null,
      richer: { id: 'sess-strap', source: 'ble_bridge' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: WORKOUT_BODY }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.deduped).toBe('richer_session_exists')
    expect(db._inserts).toHaveLength(0)
    expect(finalizeSessionRewards).not.toHaveBeenCalled()
  })

  it('pull-provider (fitbit) OW fetch failure → 200, no insert (Svix retries)', async () => {
    // Pull-based providers DO fetch the detail from OW; a fetch failure is a
    // transient skip so Svix retries. (Apple never reaches this path — it's
    // push-only and maps the payload directly.)
    getWorkoutSpy.mockRejectedValue(new Error('OW down'))
    const fitbitBody = JSON.stringify({
      type: 'workout.created',
      data: { id: 'wk-fit', user_id: 'ow-user-9', source: { provider: 'fitbit' } },
    })
    const db = makeDb({
      connection: { id: 'conn-1', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest({ body: fitbitBody }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.skipped).toBe('ow_fetch_failed')
    expect(getWorkoutSpy).toHaveBeenCalled()
    expect(db._inserts).toHaveLength(0)
  })

  it('strava event → ignored (handled directly now), no upsert / no session / no points', async () => {
    // Strava is ingested DIRECTLY now (mig 311 / strava-direct-inbound), NOT via OW.
    // A stray OW strava event must be ignored before it can reach any write path.
    const stravaUpsert = vi.fn(() => Promise.resolve({ error: null }))
    const db = makeDb({
      connection: { id: 'conn-s', contact_id: 'c-1' },
      contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
      location: { id: 'loc-1', settings: {} },
    })
    const origFrom = db.from
    db.from = (table) => (table === 'strava_activities' ? { upsert: stravaUpsert } : origFrom(table))
    createServerClient.mockReturnValue(db)
    const body = JSON.stringify({ type: 'workout.created', data: { id: 'str-1', type: 'ride', user_id: 'ow-u', start_time: '2026-06-21T06:00:00Z', source: { provider: 'strava' } } })
    const res = await POST(makeRequest({ body }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.skipped).toBe('strava_handled_directly')
    expect(stravaUpsert).not.toHaveBeenCalled()             // NO strava_activities upsert (handled directly)
    expect(db._inserts).toHaveLength(0)                     // NO heart_rate_sessions insert
    expect(finalizeSessionRewards).not.toHaveBeenCalled()  // NO points
  })
})
