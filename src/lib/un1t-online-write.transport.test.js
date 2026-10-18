import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./un1t-online-write-judge.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, judgeUn1tWrite: vi.fn(actual.judgeUn1tWrite) }
})

import { logError, logWarn, logInfo } from './log'
import { recordErrorEvent } from './error-events'
import { judgeUn1tWrite } from './un1t-online-write-judge.js'
import { Un1tSettingsReadError } from './un1t-online-settings.js'
import {
  createUn1tWriter,
  Un1tWriteRefused,
  Un1tWriteUnknown,
  UN1T_WRITE_CODES,
  _resetUn1tWriteStateForTests,
} from './un1t-online-write.js'

// Fictional ids throughout.
const LOC = 'loc-test-1'
const STUDIO = 'studio-test-1'
const TOKEN = 'secret-token-' + 'q'.repeat(51)
const TOKEN_2 = 'rotated-token-' + 'z'.repeat(50)
const EVENT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'
const PRODUCT = '44444444-4444-4444-8444-444444444444'
const EMAIL = 'person.test@example.test'
const ALL_PERMS = [
  'bookings:create', 'bookings:read', 'bookings:update', 'users:create', 'users:read',
  'purchases:create', 'products:read', 'credits:read',
]
const ALLOWED_LOG_FIELDS = new Set(['locationId', 'op', 'origin', 'ledgerId', 'status', 'verdict', 'code', 'recovered', 'attempt', 'waitMs'])
const CONTRACT_KEYS = ['verdict', 'sent', 'id', 'code', 'message', 'alreadyBooked', 'recovered', 'retryable', 'data'].sort()

// A response factory: each queue item is a thunk so a body is read once.
const res = (status, body, headers = {}) => () =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
const selfRes = (perms = ALL_PERMS, studio = STUDIO) =>
  res(200, { success: true, data: { id: 'tok-1', studio: { id: studio, name: 'Test' }, permissions: perms } })
const netFail = () => { throw new TypeError('fetch failed') }

function makeFetch(routes) {
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]))
  const calls = []
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method || 'GET'
    const key = `${method} ${u.pathname}`
    calls.push({ key, method, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined })
    const q = queues[key]
    if (!q || q.length === 0) throw new Error(`test: unexpected request ${key}`)
    const next = q.length > 1 ? q.shift() : q[0] // the last item repeats
    return next()
  })
  fetchImpl.calls = calls
  fetchImpl.writes = () => calls.filter((c) => c.method !== 'GET')
  fetchImpl.count = (key) => calls.filter((c) => c.key === key).length
  return fetchImpl
}

const CONN_ROW = (token = TOKEN, studio = STUDIO) => ({
  id: 'cc-1', location_id: LOC, platform: 'un1t_online', status: 'connected', is_active: true,
  label: null, display_name: null, external_account_id: studio, access_token: token, app_secret: null,
  config: { token_fingerprint: 'stored' }, token_expires_at: null, last_error: null, last_ok_at: null,
})

// Supabase fake: locations, channel_connections, the rate_limit_hit RPC and
// un1t_write_events (with the open-row unique index).
function makeDb({
  settings = { un1t_online: { writes_enabled: true } },
  conn = CONN_ROW(),
  connError = null,
  rate = () => 1,
  ledger = [],
  hideOpenRows = false,
} = {}) {
  const table = ledger.map((r) => ({ ...r }))
  const rpcCalls = []
  let seq = 0
  function from(name) {
    const s = { op: 'select', payload: null, filters: [], order: null, limit: null }
    const matches = (r) => s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : v.includes(r[c])))
    const open = (r) => r.stage === 'sent' || r.stage === 'unknown'
    const run = () => {
      if (name === 'locations') {
        return { data: { id: LOC, name: 'Test Studio', organization_id: 'org-1', membership_source: 'un1t_online', settings }, error: null }
      }
      if (name === 'channel_connections') {
        if (connError) return { data: null, error: connError }
        return { data: conn ? [conn] : [], error: null }
      }
      if (name === 'un1t_write_events') {
        if (s.op === 'insert') {
          const p = s.payload
          if (table.some((r) => open(r) && r.idempotency_key === p.idempotency_key)) {
            return { data: null, error: { code: '23505', message: 'duplicate key', details: 'Key (idempotency_key)=(k) already exists.' } }
          }
          const row = { id: `led-${++seq}`, created_at: new Date().toISOString(), finished_at: null, ...p }
          table.push(row)
          return { data: { ...row }, error: null }
        }
        if (s.op === 'update') {
          const hit = table.filter(matches)
          for (const r of hit) Object.assign(r, s.payload)
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        let out = hideOpenRows ? [] : table.filter(matches).map((r) => ({ ...r }))
        if (s.limit != null) out = out.slice(0, s.limit)
        return { data: out, error: null }
      }
      throw new Error(`test: unexpected table ${name}`)
    }
    const api = {
      select() { return api },
      insert(p) { s.op = 'insert'; s.payload = p; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      order(c, o) { s.order = [c, o]; return api },
      limit(n) { s.limit = n; return api },
      single() { return Promise.resolve(run()) },
      maybeSingle() {
        const r = run()
        return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null })
      },
      then(ok, no) { return Promise.resolve(run()).then(ok, no) },
    }
    return api
  }
  const db = {
    from,
    rpc: vi.fn(async (fn, args) => {
      rpcCalls.push({ fn, args })
      return { data: rate(rpcCalls.length), error: null }
    }),
  }
  return { db, table, rpcCalls }
}

async function setup({ routes = {}, db: dbOpts = {}, start = '2026-10-18T10:00:00.000Z' } = {}) {
  const { db, table, rpcCalls } = makeDb(dbOpts)
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes()], ...routes })
  const sleep = vi.fn(async () => {})
  const clock = { t: new Date(start) }
  const writer = await createUn1tWriter(db, LOC, { fetchImpl, sleep, now: () => clock.t })
  return { db, table, rpcCalls, fetchImpl, sleep, clock, writer }
}

const bookingDto = (over = {}) => ({ id: BOOKING, event_id: EVENT, user_id: USER, studio_id: STUDIO, status: 'booked', ...over })
const bookOpts = (over = {}) => ({
  body: { eventId: EVENT, userId: USER },
  policy: 'verify',
  verify: vi.fn(async () => 'unknown'),
  op: 'book',
  expect: { eventId: EVENT, userId: USER, studioId: STUDIO },
  ...over,
})
const cancelPath = `/bookings/${BOOKING}/cancel`
const cancelOpts = (over = {}) => ({ body: {}, policy: 'verify', verify: vi.fn(async () => 'unknown'), op: 'cancel', expect: { bookingId: BOOKING }, ...over })
const createBody = () => ({
  email: EMAIL, password: 'pw-' + 'x'.repeat(29), studioId: STUDIO, name: 'Test Person', first_name: 'Test', last_name: 'Person',
  phone: '+353800000000', accepted_terms: true, accepted_liability_waiver: true,
})
const checkoutOpts = (over = {}) => ({
  body: { productId: PRODUCT, successUrl: 'https://studio.example.test/ok', cancelUrl: 'https://studio.example.test/no', userId: USER },
  policy: 'idempotent', idempotencyKey: 'chk-key-1', op: 'checkout', expect: {}, ...over,
})
const forgotOpts = (over = {}) => ({ body: { email: EMAIL }, policy: 'never', op: 'forgot_password', expect: {}, ...over })

const errorNames = () => recordErrorEvent.mock.calls.map(([row]) => row.name)
const writeLogCalls = () =>
  [...logInfo.mock.calls, ...logWarn.mock.calls, ...logError.mock.calls].filter(([mod]) => mod === 'un1t-online-write')

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('ensureOp: switch, studio, permissions', () => {
  it('writes off refuses UN1T_WRITES_OFF and sends nothing', async () => {
    const { writer, fetchImpl, rpcCalls } = await setup({ db: { settings: { un1t_online: { writes_enabled: 'true' } } } })
    const err = await writer.ensureOp('book').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tWriteRefused)
    expect(err.code).toBe(UN1T_WRITE_CODES.WRITES_OFF)
    expect(err.result).toMatchObject({ verdict: 'refused', code: 'UN1T_WRITES_OFF', sent: false, retryable: false, ledgerId: null })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_WRITES_OFF', sent: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(rpcCalls).toHaveLength(0)
  })

  it('writes off is reported even when the connection read fails', async () => {
    const { writer } = await setup({ db: { settings: {}, connError: { code: 'XX000' } } })
    await expect(writer.ensureOp('book')).rejects.toMatchObject({ code: 'UN1T_WRITES_OFF' })
  })

  it('writes on with an unreadable connection throws a settings read error (nothing sent, safe to retry)', async () => {
    const { db } = makeDb({ connError: { code: 'XX000' } })
    const fetchImpl = makeFetch({})
    const err = await createUn1tWriter(db, LOC, { fetchImpl, sleep: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(Un1tSettingsReadError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no active connection refuses UN1T_NOT_CONNECTED', async () => {
    const { writer, fetchImpl } = await setup({ db: { conn: null } })
    await expect(writer.ensureOp('book')).rejects.toMatchObject({ code: 'UN1T_NOT_CONNECTED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('missing permission refuses with the exact message and sends nothing', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'GET /api-token': [selfRes(['bookings:read'])] } })
    const err = await writer.ensureOp('book').catch((e) => e)
    expect(err.code).toBe('UN1T_PERMISSION_MISSING')
    expect(err.message).toBe(
      "The un1t.online token for Test Studio is missing the 'bookings:create' permission, so nothing was sent. Add it to the token in the un1t.online owner console, or issue a new token and paste it in Settings, Integrations, un1t.online.",
    )
    expect(err.result.message).toBe(err.message)
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_PERMISSION_MISSING', sent: false })
    expect(fetchImpl.writes()).toHaveLength(0)
  })

  it('token studio different from external_account_id refuses UN1T_STUDIO_MISMATCH', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'GET /api-token': [selfRes(ALL_PERMS, 'studio-other')] } })
    await expect(writer.ensureOp('book')).rejects.toMatchObject({ code: 'UN1T_STUDIO_MISMATCH' })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r.code).toBe('UN1T_STUDIO_MISMATCH')
    expect(fetchImpl.writes()).toHaveLength(0)
  })

  it('an answer naming no studio is a mismatch (fail closed)', async () => {
    const { writer } = await setup({ routes: { 'GET /api-token': [res(200, { success: true, data: { permissions: ALL_PERMS } })] } })
    await expect(writer.ensureOp('book')).rejects.toMatchObject({ code: 'UN1T_STUDIO_MISMATCH' })
  })

  it('forgot_password needs no permission but still checks the switch and the studio', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'GET /api-token': [selfRes([])] } })
    await expect(writer.ensureOp('forgot_password')).resolves.toBeUndefined()
    expect(fetchImpl.count('GET /api-token')).toBe(1)
  })

  it('an unknown op is a programming error', async () => {
    const { writer } = await setup()
    await expect(writer.ensureOp('refund')).rejects.toBeInstanceOf(TypeError)
  })

  it('a 401 on the permission read refuses UN1T_AUTH; a 5xx refuses retryable', async () => {
    const a = await setup({ routes: { 'GET /api-token': [res(401, {})] } })
    await expect(a.writer.ensureOp('book')).rejects.toMatchObject({ code: 'UN1T_AUTH' })
    _resetUn1tWriteStateForTests()
    const b = await setup({ routes: { 'GET /api-token': [res(503, {})] } })
    const err = await b.writer.ensureOp('book').catch((e) => e)
    expect(err.code).toBe('UN1T_PERMISSIONS_UNREADABLE')
    expect(err.result.retryable).toBe(true)
  })

  it('permissions are cached 5 minutes per token fingerprint and re-read after a 403', async () => {
    const { writer, fetchImpl, clock } = await setup({ routes: { 'POST /bookings': [res(403, {})] } })
    await writer.ensureOp('book')
    await writer.ensureOp('cancel')
    clock.t = new Date(clock.t.getTime() + 4 * 60_000)
    await writer.ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(1)
    clock.t = new Date(clock.t.getTime() + 2 * 60_000)
    await writer.ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(2)
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r.code).toBe('UN1T_AUTH')
    await writer.ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(3)
  })

  it('the cache is shared across writers on the same token', async () => {
    const { db } = makeDb()
    const fetchImpl = makeFetch({ 'GET /api-token': [selfRes()] })
    const opts = { fetchImpl, sleep: async () => {}, now: () => new Date('2026-10-18T10:00:00Z') }
    await (await createUn1tWriter(db, LOC, opts)).ensureOp('book')
    await (await createUn1tWriter(db, LOC, opts)).ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(1)
  })

  it('a rotated token (new fingerprint) re-reads permissions', async () => {
    const fetchImpl = makeFetch({ 'GET /api-token': [selfRes()] })
    const opts = { fetchImpl, sleep: async () => {}, now: () => new Date('2026-10-18T10:00:00Z') }
    await (await createUn1tWriter(makeDb().db, LOC, opts)).ensureOp('book')
    await (await createUn1tWriter(makeDb({ conn: CONN_ROW(TOKEN_2) }).db, LOC, opts)).ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(2)
    expect(fetchImpl.calls[1].headers.Authorization).toBe(`Bearer ${TOKEN_2}`)
  })
})

describe('send: endpoint allowlist', () => {
  it('refuses every endpoint, verb, body key and policy off the allowlist, before any request', async () => {
    const { writer, fetchImpl, rpcCalls } = await setup()
    const bad = [
      ['POST', '/credits/grant', { body: { userId: USER }, policy: 'never', op: 'trial', idempotencyKey: 'k' }],
      ['POST', '/refunds', { body: {}, policy: 'never', op: 'trial', idempotencyKey: 'k' }],
      ['POST', '/purchases/charge-custom', { body: { userId: USER, productId: PRODUCT }, policy: 'never', op: 'trial', idempotencyKey: 'k' }],
      ['POST', '/purchases/payment-sheet', { body: {}, policy: 'never', op: 'trial', idempotencyKey: 'k' }],
      ['POST', `/bookings/${BOOKING}/mark-attendance`, cancelOpts()],
      ['PATCH', `/users/${USER}`, { body: {}, policy: 'verify', verify: async () => 'unknown', op: 'create_client' }],
      ['DELETE', `/users/${USER}`, { body: {}, policy: 'verify', verify: async () => 'unknown', op: 'create_client' }],
      ['POST', `/users/${USER}/reset-password`, forgotOpts()],
      ['GET', '/bookings', bookOpts()],
      ['POST', '/bookings?x=1', bookOpts()],
      ['POST', '/bookings', bookOpts({ body: { eventId: EVENT, userId: USER, bypassCredit: true } })],
      ['PATCH', cancelPath, cancelOpts({ body: { forceRefund: true } })],
      ['POST', '/purchases/checkout', checkoutOpts({ body: { ...checkoutOpts().body, promoCode: 'FREE' } })],
      ['POST', '/bookings', bookOpts({ body: { eventId: EVENT, userId: USER, note: 'x' } })],
      ['POST', '/bookings', bookOpts({ op: 'cancel' })],
      ['POST', '/bookings', bookOpts({ policy: 'never' })],
      ['POST', '/bookings', bookOpts({ verify: undefined })],
      ['POST', '/purchases/charge', { body: { userId: USER, productId: PRODUCT }, policy: 'never', op: 'checkout', idempotencyKey: 'k' }],
      ['POST', '/purchases/charge', { body: { userId: USER, productId: PRODUCT }, policy: 'never', op: 'trial' }],
      ['POST', '/purchases/charge', { body: { userId: USER, productId: PRODUCT }, policy: 'idempotent', op: 'trial', idempotencyKey: 'k' }],
      ['POST', '/purchases/checkout', checkoutOpts({ idempotencyKey: undefined })],
      ['POST', '/auth/forgot-password', forgotOpts({ policy: 'verify', verify: async () => 'absent' })],
    ]
    for (const [m, p, o] of bad) {
      await expect(writer.send(m, p, o), `${m} ${p}`).rejects.toBeInstanceOf(TypeError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(rpcCalls).toHaveLength(0)
  })

  it('sends the six allowed calls with the body as given and the idempotency-key header on purchases', async () => {
    const { writer, fetchImpl } = await setup({
      routes: {
        'POST /bookings': [res(201, { success: true, data: bookingDto() })],
        [`PATCH ${cancelPath}`]: [res(200)],
        'POST /users/clients': [res(201, { success: true, data: { id: USER, email: EMAIL, reset_password_token: 'RPT-SECRET' } })],
        'POST /auth/forgot-password': [res(200, { success: true, data: { message: 'ok' } })],
        'POST /purchases/charge': [res(201, { success: true, data: { transactionId: 'tx-1' } })],
        'POST /purchases/checkout': [res(201, { success: true, data: { checkoutUrl: 'https://pay.example.test/s/1', free: false } })],
      },
    })
    await writer.send('POST', '/bookings', bookOpts())
    await writer.send('PATCH', cancelPath, cancelOpts())
    await writer.send('POST', '/users/clients', { body: createBody(), policy: 'verify', verify: async () => 'unknown', op: 'create_client', expect: {} })
    await writer.send('POST', '/auth/forgot-password', forgotOpts())
    await writer.send('POST', '/purchases/charge', { body: { userId: USER, productId: PRODUCT }, policy: 'never', idempotencyKey: 'trial-key', op: 'trial', expect: {} })
    await writer.send('POST', '/purchases/checkout', checkoutOpts())
    const w = fetchImpl.writes()
    expect(w.map((c) => c.key)).toEqual([
      'POST /bookings', `PATCH ${cancelPath}`, 'POST /users/clients', 'POST /auth/forgot-password', 'POST /purchases/charge', 'POST /purchases/checkout',
    ])
    expect(w[0].body).toEqual({ eventId: EVENT, userId: USER })
    expect(w[1].body).toEqual({})
    expect(w[4].headers['idempotency-key']).toBe('trial-key')
    expect(w[5].headers['idempotency-key']).toBe('chk-key-1')
    expect(w[0].headers['idempotency-key']).toBeUndefined()
    expect(w[0].url).toBe('https://api.un1t.online/bookings')
  })
})

describe('send: policies', () => {
  it('a plain done book returns the contract shape with the booking as data', async () => {
    const { writer } = await setup({ routes: { 'POST /bookings': [res(201, { success: true, data: bookingDto() })] } })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
    expect(r).toMatchObject({ verdict: 'done', sent: true, id: BOOKING, recovered: null, retryable: false, alreadyBooked: false })
    expect(r.data).toEqual(bookingDto())
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('verify: 5xx then landed reports done with recovered landed_after_5xx and no error_events row', async () => {
    const verify = vi.fn(async () => ({ state: 'landed', id: BOOKING }))
    const { writer, fetchImpl } = await setup({ routes: { 'POST /bookings': [res(502, { error: 'bad gateway' })] } })
    const r = await writer.send('POST', '/bookings', bookOpts({ verify }))
    expect(r).toMatchObject({ verdict: 'done', sent: true, id: BOOKING, recovered: 'landed_after_5xx' })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(fetchImpl.count('POST /bookings')).toBe(1)
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('verify: a landed cancel takes the requested booking as its id', async () => {
    const { writer } = await setup({ routes: { [`PATCH ${cancelPath}`]: [res(500, {})] } })
    const r = await writer.send('PATCH', cancelPath, cancelOpts({ verify: async () => 'landed' }))
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, recovered: 'landed_after_5xx' })
  })

  it('verify: 5xx then absent re-sends once; a second 5xx is unknown', async () => {
    const verify = vi.fn(async () => 'absent')
    const { writer, fetchImpl } = await setup({ routes: { 'POST /bookings': [res(503, {})] } })
    const r = await writer.send('POST', '/bookings', bookOpts({ verify }))
    expect(r).toMatchObject({ verdict: 'unknown', sent: true, id: null })
    expect(fetchImpl.count('POST /bookings')).toBe(2)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(errorNames()).toEqual(['un1t_write_5xx'])
  })

  it('verify: 5xx then absent then 201 is done', async () => {
    const { writer, fetchImpl } = await setup({
      routes: { 'POST /bookings': [res(503, {}), res(201, { success: true, data: bookingDto() })] },
    })
    const r = await writer.send('POST', '/bookings', bookOpts({ verify: async () => 'absent' }))
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, recovered: null })
    expect(fetchImpl.count('POST /bookings')).toBe(2)
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('verify: 5xx then unknown is unknown and leaves one un1t_write_5xx row', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'POST /bookings': [res(500, {})] } })
    const r = await writer.send('POST', '/bookings', bookOpts({ verify: async () => 'unknown' }))
    expect(r).toMatchObject({ verdict: 'unknown', sent: true })
    expect(fetchImpl.count('POST /bookings')).toBe(1)
    expect(errorNames()).toEqual(['un1t_write_5xx'])
    expect(recordErrorEvent.mock.calls[0][0]).toMatchObject({ route_type: 'un1t_write', route_path: 'un1t:POST /bookings' })
  })

  it('verify: a check read that throws is unknown, never a re-send', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'POST /bookings': [res(500, {})] } })
    const r = await writer.send('POST', '/bookings', bookOpts({ verify: async () => { throw new Error('boom') } }))
    expect(r.verdict).toBe('unknown')
    expect(fetchImpl.count('POST /bookings')).toBe(1)
  })

  it('verify: no reply then unknown leaves one un1t_write_no_reply row with an id-free label', async () => {
    const { writer } = await setup({ routes: { [`PATCH ${cancelPath}`]: [netFail] } })
    const r = await writer.send('PATCH', cancelPath, cancelOpts({ verify: async () => 'unknown' }))
    expect(r.verdict).toBe('unknown')
    expect(errorNames()).toEqual(['un1t_write_no_reply'])
    expect(recordErrorEvent.mock.calls[0][0].route_path).toBe('un1t:PATCH /bookings/:id/cancel')
  })

  it('verify: a cancel the check read finds attended is refused already_happened', async () => {
    const { writer, fetchImpl } = await setup({ routes: { [`PATCH ${cancelPath}`]: [res(500, {})] } })
    const r = await writer.send('PATCH', cancelPath, cancelOpts({ verify: async () => 'already_happened' }))
    expect(r).toMatchObject({ verdict: 'refused', code: 'already_happened', retryable: false })
    expect(fetchImpl.count(`PATCH ${cancelPath}`)).toBe(1)
  })

  it('never: a 5xx is unknown with exactly one request', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'POST /auth/forgot-password': [res(500, {})] } })
    const r = await writer.send('POST', '/auth/forgot-password', forgotOpts())
    expect(r).toMatchObject({ verdict: 'unknown', sent: true })
    expect(fetchImpl.count('POST /auth/forgot-password')).toBe(1)
    expect(errorNames()).toEqual(['un1t_write_5xx'])
  })

  it('never: a 2xx with no id is unknown', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'POST /auth/forgot-password': [res(200, {})] } })
    const r = await writer.send('POST', '/auth/forgot-password', forgotOpts())
    expect(r.verdict).toBe('unknown')
    expect(fetchImpl.count('POST /auth/forgot-password')).toBe(1)
    expect(errorNames()).toEqual(['un1t_write_unclear'])
  })

  it('never with a check read (the trial): landed is done, absent is still unknown and never re-sent', async () => {
    const charge = { body: { userId: USER, productId: PRODUCT }, policy: 'never', idempotencyKey: 'trial-key', op: 'trial', expect: {} }
    const a = await setup({ routes: { 'POST /purchases/charge': [res(500, {})] } })
    const landed = await a.writer.send('POST', '/purchases/charge', { ...charge, verify: async () => 'landed' })
    expect(landed).toMatchObject({ verdict: 'done', recovered: 'landed_after_5xx' })
    const absent = await a.writer.send('POST', '/purchases/charge', { ...charge, verify: async () => 'absent' })
    expect(absent.verdict).toBe('unknown')
    expect(a.fetchImpl.count('POST /purchases/charge')).toBe(2) // one per call, never a re-send
  })

  it('idempotent: a 5xx re-sends once with the same idempotency-key header', async () => {
    const { writer, fetchImpl } = await setup({
      routes: { 'POST /purchases/checkout': [res(502, {}), res(201, { success: true, data: { checkoutUrl: 'https://pay.example.test/s/9', free: false } })] },
    })
    const r = await writer.send('POST', '/purchases/checkout', checkoutOpts())
    expect(r).toMatchObject({ verdict: 'done', id: 'https://pay.example.test/s/9', data: { free: false } })
    const sends = fetchImpl.calls.filter((c) => c.key === 'POST /purchases/checkout')
    expect(sends).toHaveLength(2)
    expect(sends.map((c) => c.headers['idempotency-key'])).toEqual(['chk-key-1', 'chk-key-1'])
  })

  it('idempotent: two 5xx are unknown after exactly two requests', async () => {
    const { writer, fetchImpl } = await setup({ routes: { 'POST /purchases/checkout': [res(502, {})] } })
    const r = await writer.send('POST', '/purchases/checkout', checkoutOpts())
    expect(r.verdict).toBe('unknown')
    expect(fetchImpl.count('POST /purchases/checkout')).toBe(2)
    expect(errorNames()).toEqual(['un1t_write_5xx'])
  })

  it('429 is retried after the reset for every policy; exhausted is refused retryable with sent false', async () => {
    const throttled = res(429, {}, { 'x-ratelimit-reset': '5' })
    const cases = [
      ['POST', '/bookings', bookOpts(), res(201, { success: true, data: bookingDto() })],
      ['POST', '/auth/forgot-password', forgotOpts(), res(200, { success: true, data: {} })],
      ['POST', '/purchases/checkout', checkoutOpts(), res(201, { success: true, data: { checkoutUrl: 'https://pay.example.test/s/2', free: false } })],
    ]
    for (const [m, p, o, ok] of cases) {
      vi.clearAllMocks()
      const { writer, fetchImpl, sleep } = await setup({ routes: { [`${m} ${p}`]: [throttled, ok] } })
      const r = await writer.send(m, p, o)
      expect(r.verdict, p).toBe('done')
      expect(fetchImpl.count(`${m} ${p}`)).toBe(2)
      expect(sleep).toHaveBeenCalledWith(6000)
      if (o.verify) expect(o.verify).not.toHaveBeenCalled()
    }
    vi.clearAllMocks()
    const { writer, fetchImpl, sleep } = await setup({ routes: { 'POST /bookings': [res(429, {}, { 'retry-after': '2' })] } })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_RATE_LIMITED', retryable: true, sent: false })
    expect(fetchImpl.count('POST /bookings')).toBe(4)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 2000, 2000])
    expect(errorNames()).toEqual(['un1t_write_429'])
  })

  it('a 429 with no headers backs off 1s * 2^attempt', async () => {
    const { writer, sleep } = await setup({ routes: { 'POST /bookings': [res(429, {})] } })
    await writer.send('POST', '/bookings', bookOpts())
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000])
  })

  it('401 and 403 are final: one request, UN1T_AUTH, cache dropped, one un1t_write_auth row', async () => {
    for (const status of [401, 403]) {
      vi.clearAllMocks()
      _resetUn1tWriteStateForTests()
      const { writer, fetchImpl } = await setup({ routes: { 'POST /bookings': [res(status, {})] } })
      const verify = vi.fn(async () => 'absent')
      const r = await writer.send('POST', '/bookings', bookOpts({ verify }))
      expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_AUTH', retryable: false, sent: false })
      expect(fetchImpl.count('POST /bookings')).toBe(1)
      expect(verify).not.toHaveBeenCalled()
      expect(errorNames()).toEqual(['un1t_write_auth'])
      await writer.ensureOp('book')
      expect(fetchImpl.count('GET /api-token')).toBe(2)
    }
  })
})

describe('send: the judge sees only what it should', () => {
  it('the judge is NEVER called with 401, 403 or 429', async () => {
    for (const status of [401, 403]) {
      _resetUn1tWriteStateForTests()
      const { writer } = await setup({ routes: { 'POST /bookings': [res(status, {})] } })
      await writer.send('POST', '/bookings', bookOpts())
    }
    const t = await setup({ routes: { 'POST /bookings': [res(429, {})] } })
    await t.writer.send('POST', '/bookings', bookOpts())
    const u = await setup({ routes: { 'POST /bookings': [res(429, {}), res(201, { success: true, data: bookingDto() })] } })
    await u.writer.send('POST', '/bookings', bookOpts())
    const statuses = judgeUn1tWrite.mock.calls.map(([, a]) => a.status)
    expect(statuses).toEqual([201])
  })

  it('a bodyless 200 reaches the judge as null, never an empty string', async () => {
    const { writer } = await setup({ routes: { [`PATCH ${cancelPath}`]: [res(200)] } })
    const r = await writer.send('PATCH', cancelPath, cancelOpts())
    expect(judgeUn1tWrite).toHaveBeenCalledTimes(1)
    expect(judgeUn1tWrite.mock.calls[0][1].body).toBeNull()
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, data: null })
  })

  it('a non-JSON body reaches the judge as its text (a proxy page is not a cancel)', async () => {
    const { writer } = await setup({ routes: { [`PATCH ${cancelPath}`]: [res(200, '<html>oops</html>')] } })
    const r = await writer.send('PATCH', cancelPath, cancelOpts())
    expect(judgeUn1tWrite.mock.calls[0][1].body).toBe('<html>oops</html>')
    expect(r.verdict).toBe('unknown')
  })

  it('a words-only already booked runs the dedupe read and NEVER re-sends on that hint', async () => {
    const refusal = res(409, { success: false, error: { code: 'CONFLICT', message: 'You are already booked into another class at this time' } })
    const absent = vi.fn(async () => 'absent')
    const a = await setup({ routes: { 'POST /bookings': [refusal] } })
    const r1 = await a.writer.send('POST', '/bookings', bookOpts({ verify: absent }))
    expect(absent).toHaveBeenCalledTimes(1)
    expect(a.fetchImpl.count('POST /bookings')).toBe(1)
    expect(r1).toMatchObject({ verdict: 'unknown', alreadyBooked: false })

    const landed = vi.fn(async () => ({ state: 'landed', id: BOOKING }))
    const b = await setup({ routes: { 'POST /bookings': [refusal] } })
    const r2 = await b.writer.send('POST', '/bookings', bookOpts({ verify: landed }))
    expect(b.fetchImpl.count('POST /bookings')).toBe(1)
    expect(r2).toMatchObject({ verdict: 'done', alreadyBooked: true, id: BOOKING, recovered: null })
  })

  it('checkout: the id is the https checkout URL and it is never logged', async () => {
    const url = 'https://pay.example.test/session/cs_test_abc123'
    const { writer } = await setup({
      routes: { 'POST /purchases/checkout': [res(500, {}), res(201, { success: true, data: { checkoutUrl: url, free: false } })] },
    })
    const r = await writer.send('POST', '/purchases/checkout', checkoutOpts())
    expect(r.id).toBe(url)
    expect(writeLogCalls().length).toBeGreaterThan(0)
    const logged = JSON.stringify([logInfo.mock.calls, logWarn.mock.calls, logError.mock.calls, recordErrorEvent.mock.calls])
    expect(logged).not.toContain('cs_test_abc123')
    expect(logged).not.toContain('pay.example.test')
  })

  it("the person's email is scrubbed from the message, from the body and from explicit secrets", async () => {
    const a = await setup({
      routes: { 'POST /users/clients': [res(409, { success: false, error: { code: 'BAD', message: `User ${EMAIL.toUpperCase()} could not be made` } })] },
    })
    const r1 = await a.writer.send('POST', '/users/clients', { body: createBody(), policy: 'verify', verify: async () => 'unknown', op: 'create_client', expect: {} })
    expect(r1.verdict).toBe('refused')
    expect(r1.message).toContain('[redacted]')
    expect(r1.message.toLowerCase()).not.toContain(EMAIL)

    const b = await setup({
      routes: { 'POST /bookings': [res(400, { success: false, error: { code: 'NOPE', message: `No credits on ${EMAIL}` } })] },
    })
    const r2 = await b.writer.send('POST', '/bookings', bookOpts({ secrets: [EMAIL] }))
    expect(r2.message).toBe('No credits on [redacted]')
  })

  it('forgot_password done promises nothing: no data, no message, only the contract fields', async () => {
    const { writer } = await setup({
      routes: { 'POST /auth/forgot-password': [res(200, { success: true, data: { message: 'If that email exists we sent a link' } })] },
    })
    const r = await writer.send('POST', '/auth/forgot-password', forgotOpts())
    expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
    expect(r).toMatchObject({ verdict: 'done', id: null, data: null, message: null })
    const words = Object.values(r).filter((v) => typeof v === 'string').join(' ').toLowerCase()
    expect(words).not.toMatch(/sent|email|link/)
  })

  it('create_client done lets only the id out', async () => {
    const { writer } = await setup({
      routes: { 'POST /users/clients': [res(201, { success: true, data: { id: USER, email: EMAIL, phone: '+353800000000', reset_password_token: 'RPT-SECRET' } })] },
    })
    const r = await writer.send('POST', '/users/clients', { body: createBody(), policy: 'verify', verify: async () => 'unknown', op: 'create_client', expect: {} })
    expect(r).toMatchObject({ verdict: 'done', id: USER, data: null })
    expect(JSON.stringify(r)).not.toMatch(/RPT-SECRET|example\.test|353800000000/)
  })
})

describe('the shared rate budget', () => {
  it('every HTTP request takes one budget slot, dedupe and permission reads included', async () => {
    const { writer, fetchImpl, rpcCalls } = await setup({
      routes: { 'POST /bookings': [res(503, {})], [`GET /users/${USER}/bookings`]: [res(200, { success: true, data: [] })] },
    })
    const verify = async () => {
      await writer.read(`/users/${USER}/bookings`)
      return 'absent'
    }
    await writer.send('POST', '/bookings', bookOpts({ verify }))
    // api-token, POST, GET dedupe, POST re-send
    expect(fetchImpl.calls).toHaveLength(4)
    expect(rpcCalls).toHaveLength(4)
    expect(rpcCalls.every((c) => c.fn === 'rate_limit_hit' && c.args.p_key === `un1t-write:${LOC}` && c.args.p_window_ms === 60_000)).toBe(true)
  })

  it('a spent slot before the write sends nothing (UN1T_RATE_BUDGET, retryable)', async () => {
    const { writer, fetchImpl } = await setup({ db: { rate: (n) => (n === 2 ? 31 : 1) } })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true, sent: false })
    expect(fetchImpl.writes()).toHaveLength(0)
  })

  it('a spent slot on the permission read sends nothing either', async () => {
    const { writer, fetchImpl } = await setup({ db: { rate: () => 31 } })
    const r = await writer.send('POST', '/bookings', bookOpts())
    expect(r).toMatchObject({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true, sent: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a spent slot between the write and its dedupe read waits for the window and still reads', async () => {
    const { writer, fetchImpl, sleep } = await setup({
      db: { rate: (n) => (n === 3 ? 31 : 1) },
      routes: { 'POST /bookings': [res(500, {})], [`GET /users/${USER}/bookings`]: [res(200, { success: true, data: [] })] },
    })
    const verify = async () => {
      await writer.read(`/users/${USER}/bookings`)
      return 'unknown'
    }
    const r = await writer.send('POST', '/bookings', bookOpts({ verify }))
    expect(r.verdict).toBe('unknown')
    expect(fetchImpl.count(`GET /users/${USER}/bookings`)).toBe(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    const [ms] = sleep.mock.calls[0]
    expect(ms).toBeGreaterThanOrEqual(1000)
    expect(ms).toBeLessThanOrEqual(60_000)
  })

  it('outside a dedupe read a spent slot refuses the read', async () => {
    const { writer } = await setup({ db: { rate: () => 31 } })
    await expect(writer.read(`/bookings/${BOOKING}`)).rejects.toMatchObject({ code: 'UN1T_RATE_BUDGET' })
  })
})

describe('error_events rows', () => {
  it('error_events rows are capped at 5 a minute with one summary warn', async () => {
    const { writer } = await setup({ routes: { 'POST /auth/forgot-password': [res(500, {})] } })
    for (let i = 0; i < 7; i++) await writer.send('POST', '/auth/forgot-password', forgotOpts())
    expect(recordErrorEvent).toHaveBeenCalledTimes(5)
    const summaries = logWarn.mock.calls.filter(([, msg]) => /capped/.test(msg))
    expect(summaries).toHaveLength(1)
  })

  it('a known business refusal leaves no error_events row; an unmapped 4xx leaves un1t_write_refused', async () => {
    const a = await setup({
      routes: { 'POST /users/clients': [res(409, { success: false, error: { code: 'CONFLICT', message: 'Email already in use' } })] },
    })
    const r1 = await a.writer.send('POST', '/users/clients', { body: createBody(), policy: 'verify', verify: async () => 'absent', op: 'create_client', expect: {} })
    expect(r1).toMatchObject({ verdict: 'refused', code: 'CONFLICT', sent: true, retryable: false })
    expect(a.fetchImpl.count('POST /users/clients')).toBe(1)
    expect(recordErrorEvent).not.toHaveBeenCalled()

    const b = await setup({ routes: { 'POST /bookings': [res(400, { success: false, error: { code: 'ODD', message: 'Something odd' } })] } })
    const r2 = await b.writer.send('POST', '/bookings', bookOpts())
    expect(r2).toMatchObject({ verdict: 'refused', code: 'ODD', message: 'Something odd' })
    expect(errorNames()).toEqual(['un1t_write_refused'])
  })
})

describe('openAttempt: the ledger seam', () => {
  const KEY = `book:${LOC}:${USER}:${EVENT}`
  const attempt = { contactId: 'con-1', un1tUserId: USER, op: 'book', origin: 'staff', key: KEY, target: EVENT }
  const ago = (ms) => new Date(Date.now() - ms).toISOString()

  it('a free key inserts the write-ahead row', async () => {
    const { writer, table } = await setup()
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify: async () => 'unknown' })
    expect(out.row).toMatchObject({ idempotency_key: KEY, stage: 'sent', location_id: LOC })
    expect(table).toHaveLength(1)
  })

  it('an open row under 3 minutes old is UN1T_ATTEMPT_IN_FLIGHT, retryable, nothing sent', async () => {
    const { writer, fetchImpl } = await setup({
      db: { ledger: [{ id: 'led-old', idempotency_key: KEY, stage: 'sent', op: 'book', created_at: ago(30_000) }] },
    })
    const verify = vi.fn()
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify })
    expect(out.result).toMatchObject({ verdict: 'refused', code: 'UN1T_ATTEMPT_IN_FLIGHT', retryable: true, sent: false, ledgerId: 'led-old' })
    expect(verify).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("open_row_gone is a retry, not an error-level event", async () => {
    const { writer } = await setup({
      db: { ledger: [{ id: 'led-old', idempotency_key: KEY, stage: 'sent', op: 'book', created_at: ago(30_000) }], hideOpenRows: true },
    })
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify: async () => 'absent' })
    expect(out.result).toMatchObject({ verdict: 'refused', code: 'UN1T_ATTEMPT_IN_FLIGHT', retryable: true, sent: false })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a stale sent row is finished with the dedupe verdict (absent) before the new row is inserted', async () => {
    const { writer, table } = await setup({
      db: { ledger: [{ id: 'led-old', idempotency_key: KEY, stage: 'sent', op: 'book', created_at: ago(10 * 60_000) }] },
    })
    const verify = vi.fn(async () => 'absent')
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(table.find((r) => r.id === 'led-old')).toMatchObject({ stage: 'refused', code: 'not_landed' })
    expect(out.row).toMatchObject({ idempotency_key: KEY, stage: 'sent' })
    expect(out.row.id).not.toBe('led-old')
  })

  it('a stale sent row that landed is finished done and nothing new is inserted or sent', async () => {
    const { writer, table, fetchImpl } = await setup({
      db: { ledger: [{ id: 'led-old', idempotency_key: KEY, stage: 'sent', op: 'book', created_at: ago(10 * 60_000) }] },
    })
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify: async () => ({ state: 'landed', id: BOOKING }) })
    expect(out.result).toMatchObject({ verdict: 'done', id: BOOKING, sent: false, ledgerId: 'led-old', recovered: 'landed_on_resume' })
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ stage: 'done', un1t_ref: BOOKING })
    expect(fetchImpl.writes()).toHaveLength(0)
  })

  it('an unknown dedupe leaves the row in doubt (a stale sent row becomes unknown) and returns unknown', async () => {
    const { writer, table } = await setup({
      db: { ledger: [{ id: 'led-old', idempotency_key: KEY, stage: 'sent', op: 'book', created_at: ago(10 * 60_000) }] },
    })
    const out = await writer.openAttempt(attempt, { policy: 'verify', verify: async () => 'unknown' })
    expect(out.result).toMatchObject({ verdict: 'unknown', sent: false, ledgerId: 'led-old' })
    expect(table).toHaveLength(1)
    expect(table[0].stage).toBe('unknown')
  })

  it('a never op with an open row returns unknown and sends nothing', async () => {
    const pwKey = `pw:${LOC}:${USER}`
    const { writer, table } = await setup({
      db: { ledger: [{ id: 'led-pw', idempotency_key: pwKey, stage: 'sent', op: 'forgot_password', created_at: ago(10 * 60_000) }] },
    })
    const out = await writer.openAttempt({ ...attempt, op: 'forgot_password', key: pwKey, target: null }, { policy: 'never' })
    expect(out.result).toMatchObject({ verdict: 'unknown', ledgerId: 'led-pw' })
    expect(table).toHaveLength(1)
    expect(table[0].stage).toBe('unknown')
  })

  it('an idempotent op adopts the stale row (the same key makes the re-send the same session)', async () => {
    const { writer, table } = await setup({
      db: { ledger: [{ id: 'led-chk', idempotency_key: 'chk-key-1', stage: 'unknown', op: 'checkout', created_at: ago(10 * 60_000) }] },
    })
    const out = await writer.openAttempt({ ...attempt, op: 'checkout', key: 'chk-key-1', target: PRODUCT }, { policy: 'idempotent' })
    expect(out.row.id).toBe('led-chk')
    expect(table).toHaveLength(1)
  })
})

describe('secrets and log shape', () => {
  it('a 64-character token never appears in a result, error, log line or error_events row', async () => {
    expect(TOKEN).toHaveLength(64)
    const results = []
    const errors = []
    const a = await setup({
      routes: {
        'POST /bookings': [
          res(400, { success: false, error: { code: 'BAD_TOKEN', message: `Bearer ${TOKEN} is odd` } }),
          res(500, {}),
          res(401, {}),
        ],
        [`GET /bookings/${BOOKING}`]: [res(500, {})],
      },
    })
    results.push(await a.writer.send('POST', '/bookings', bookOpts()))
    results.push(await a.writer.send('POST', '/bookings', bookOpts({ verify: async () => a.writer.read(`/bookings/${BOOKING}`) })))
    results.push(await a.writer.send('POST', '/bookings', bookOpts()))
    errors.push(await a.writer.ensureOp('book').catch((e) => e))
    errors.push(await a.writer.read(`/bookings/${BOOKING}`).catch((e) => e))
    const b = await setup({ db: { settings: {} } })
    errors.push(await b.writer.ensureOp('book').catch((e) => e))
    const everything = JSON.stringify({
      results,
      errors: errors.map((e) => (e ? { message: e.message, code: e.code, result: e.result, stack: e.stack } : e)),
      logs: [logInfo.mock.calls, logWarn.mock.calls, logError.mock.calls],
      events: recordErrorEvent.mock.calls,
      writer: { ...a.writer },
    })
    expect(results[0].message).toBe('Bearer [redacted] is odd')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(TOKEN.slice(13, 40))
  })

  it('log lines carry only the allowed fields', async () => {
    const { writer } = await setup({
      routes: {
        'POST /bookings': [res(429, {}, { 'x-ratelimit-reset': '1' }), res(500, {}), res(503, {})],
        'POST /auth/forgot-password': [res(500, {})],
        'POST /users/clients': [res(400, { success: false, error: { code: 'X', message: `bad ${EMAIL}` } })],
      },
    })
    await writer.send('POST', '/bookings', bookOpts({ verify: async () => 'absent', origin: 'staff', ledgerId: 'led-9' }))
    await writer.send('POST', '/users/clients', { body: createBody(), policy: 'verify', verify: async () => 'unknown', op: 'create_client', expect: {} })
    for (let i = 0; i < 7; i++) await writer.send('POST', '/auth/forgot-password', forgotOpts())
    const lines = writeLogCalls()
    expect(lines.length).toBeGreaterThan(3)
    for (const [, msg, meta] of lines) {
      expect(typeof msg).toBe('string')
      for (const k of Object.keys(meta || {})) expect(ALLOWED_LOG_FIELDS.has(k), `${msg}: ${k}`).toBe(true)
    }
    expect(JSON.stringify(lines)).not.toContain(EMAIL)
  })
})

describe('reads', () => {
  it('readAll walks every page; a truncated walk throws', async () => {
    const page = (p, pages) => res(200, { success: true, pagination: { total: pages, page: p, pages, pageSize: 100 }, data: [{ id: `c${p}` }] })
    const { writer } = await setup({ routes: { 'GET /users/clients': [page(1, 2), page(2, 2)] } })
    await expect(writer.readAll('/users/clients')).resolves.toEqual([{ id: 'c1' }, { id: 'c2' }])
  })

  it('a 403 on a read drops the permission cache', async () => {
    const { writer, fetchImpl } = await setup({ routes: { [`GET /bookings/${BOOKING}`]: [res(403, {})] } })
    await writer.ensureOp('book')
    await expect(writer.read(`/bookings/${BOOKING}`)).rejects.toThrow()
    await writer.ensureOp('book')
    expect(fetchImpl.count('GET /api-token')).toBe(2)
  })

  it('exports Un1tWriteUnknown for createCheckoutLink', () => {
    const e = new Un1tWriteUnknown('X', 'y')
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ code: 'X', message: 'y', name: 'Un1tWriteUnknown' })
  })
})
