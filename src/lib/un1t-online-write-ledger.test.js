import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError } from './log'
import {
  ledgerKey,
  UN1T_IN_FLIGHT_MS,
  beginAttempt,
  finishAttempt,
  findDone,
  listAttempts,
} from './un1t-online-write-ledger.js'

const NOW = new Date('2026-10-18T10:00:00.000Z')

// A recording fake of the one table. insert().select().single() enforces the
// open-row unique index (idempotency_key where stage in sent/unknown) and
// answers 23505 the way PostgREST does.
function makeDb({ rows = [], failInsert = null, failSelect = null, failUpdate = null, updateMatches = true } = {}) {
  const table = rows.map((r) => ({ ...r }))
  const log = []
  let seq = 0
  function builder() {
    const s = { op: 'select', payload: null, cols: null, filters: [], order: null, limit: null, wantRows: false }
    const matches = (r) =>
      s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : v.includes(r[c])))
    const run = () => {
      log.push({ op: s.op, payload: s.payload, cols: s.cols, filters: s.filters, order: s.order, limit: s.limit })
      if (s.op === 'insert') {
        if (failInsert) return { data: null, error: failInsert }
        const p = s.payload
        const open = (r) => r.stage === 'sent' || r.stage === 'unknown'
        if (open(p) && table.some((r) => open(r) && r.idempotency_key === p.idempotency_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "un1t_write_events_one_open"', details: 'Key (idempotency_key)=(secret-key) already exists.' } }
        }
        const row = { id: `led-${++seq}`, created_at: NOW.toISOString(), finished_at: null, ...p }
        table.push(row)
        return { data: { ...row }, error: null }
      }
      if (s.op === 'update') {
        if (failUpdate) return { data: null, error: failUpdate }
        const hit = updateMatches ? table.filter(matches) : []
        for (const r of hit) Object.assign(r, s.payload)
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      if (failSelect) return { data: null, error: failSelect }
      let out = table.filter(matches).map((r) => ({ ...r }))
      if (s.order) {
        const [col, asc] = s.order
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (s.limit != null) out = out.slice(0, s.limit)
      return { data: out, error: null }
    }
    const api = {
      select(cols) { s.cols = cols; return api },
      insert(p) { s.op = 'insert'; s.payload = p; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      order(c, o) { s.order = [c, o?.ascending !== false]; return api },
      limit(n) { s.limit = n; return api },
      single() { const r = run(); return Promise.resolve(r.error ? r : { data: r.data, error: null }) },
      maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }) },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return api
  }
  return { table, log, from: () => builder() }
}

const ARGS = {
  locationId: 'loc-1',
  contactId: 'con-1',
  un1tUserId: 'u1t-user-1',
  op: 'book',
  origin: 'funnel',
  originRef: 'req-1',
  actorUserId: 'usr-1',
  key: 'book:loc-1:u1t-user-1:evt-1',
  target: 'evt-1',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  logError.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('ledgerKey', () => {
  it('ledgerKey shapes', () => {
    expect(ledgerKey.create('loc-1', 'con-1')).toBe('create:loc-1:con-1')
    expect(ledgerKey.trial('loc-1', 'u1', 'prod-1', 'charge')).toBe('trial:loc-1:u1:prod-1:charge')
    expect(ledgerKey.trial('loc-1', 'u1', 'prod-1', 'free_checkout')).toBe('trial:loc-1:u1:prod-1:free_checkout')
    expect(ledgerKey.book('loc-1', 'u1', 'evt-1')).toBe('book:loc-1:u1:evt-1')
    expect(ledgerKey.cancel('loc-1', 'bk-1')).toBe('cancel:loc-1:bk-1')
    expect(ledgerKey.pw('loc-1', 'u1')).toBe('pw:loc-1:u1')
  })
  it('refuses a missing part rather than minting a key with "undefined" in it', () => {
    expect(() => ledgerKey.create('loc-1', undefined)).toThrow(TypeError)
    expect(() => ledgerKey.book('loc-1', 'u1', '')).toThrow(TypeError)
    expect(() => ledgerKey.trial('loc-1', 'u1', 'p', null)).toThrow(TypeError)
  })
  it('the in-flight window is three minutes', () => {
    expect(UN1T_IN_FLIGHT_MS).toBe(180_000)
  })
})

describe('beginAttempt', () => {
  it('beginAttempt inserts a sent row with every field', async () => {
    const db = makeDb()
    const out = await beginAttempt(db, {
      ...ARGS,
      op: 'trial',
      method: 'charge',
      termsAcceptedAt: '2026-10-18T09:00:00.000Z',
      termsSource: 'website',
      key: 'trial:loc-1:u1t-user-1:prod-1:charge',
      target: 'prod-1',
    })
    expect(out.row).toMatchObject({
      id: 'led-1',
      stage: 'sent',
      location_id: 'loc-1',
      contact_id: 'con-1',
      un1t_user_id: 'u1t-user-1',
      op: 'trial',
      origin: 'funnel',
      origin_ref: 'req-1',
      actor_user_id: 'usr-1',
      idempotency_key: 'trial:loc-1:u1t-user-1:prod-1:charge',
      target: 'prod-1',
      method: 'charge',
      terms_accepted_at: '2026-10-18T09:00:00.000Z',
      terms_source: 'website',
    })
    const ins = db.log.find((l) => l.op === 'insert')
    expect(ins.payload.stage).toBe('sent')
    expect(ins.cols).not.toContain('*')
    expect('open' in out).toBe(false)
  })

  it('writes null for every optional field left out', async () => {
    const db = makeDb()
    await beginAttempt(db, { locationId: 'loc-1', op: 'forgot_password', origin: 'staff', key: 'pw:loc-1:u1' })
    const p = db.log.find((l) => l.op === 'insert').payload
    expect(p).toMatchObject({
      contact_id: null,
      un1t_user_id: null,
      origin_ref: null,
      actor_user_id: null,
      target: null,
      method: null,
      terms_accepted_at: null,
      terms_source: null,
    })
  })

  it('beginAttempt on 23505 returns the open row and inFlight true when it is younger than 3 minutes', async () => {
    const young = new Date(NOW.getTime() - 60_000).toISOString()
    const db = makeDb({ rows: [{ id: 'led-old', idempotency_key: ARGS.key, stage: 'sent', created_at: young }] })
    const out = await beginAttempt(db, ARGS)
    expect(out.inFlight).toBe(true)
    expect(out.open.id).toBe('led-old')
    expect('row' in out).toBe(false)
    expect(db.table).toHaveLength(1)
  })

  it('inFlight false for an older sent row or an unknown row', async () => {
    const old = new Date(NOW.getTime() - UN1T_IN_FLIGHT_MS - 1).toISOString()
    const edge = new Date(NOW.getTime() - UN1T_IN_FLIGHT_MS).toISOString()
    const fresh = new Date(NOW.getTime() - 1_000).toISOString()

    const a = await beginAttempt(makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'sent', created_at: old }] }), ARGS)
    expect(a).toMatchObject({ inFlight: false, open: { id: 'a' } })

    const b = await beginAttempt(makeDb({ rows: [{ id: 'b', idempotency_key: ARGS.key, stage: 'sent', created_at: edge }] }), ARGS)
    expect(b.inFlight).toBe(false)

    // An unknown row is never "in flight", however young: the resume reads and decides.
    const c = await beginAttempt(makeDb({ rows: [{ id: 'c', idempotency_key: ARGS.key, stage: 'unknown', created_at: fresh }] }), ARGS)
    expect(c).toMatchObject({ inFlight: false, open: { id: 'c', stage: 'unknown' } })
  })

  it('beginAttempt throws on any other DB error, naming the code and not the row', async () => {
    const db = makeDb({ failInsert: { code: '23514', message: 'new row violates check constraint', details: 'Failing row contains (secret)' } })
    const err = await beginAttempt(db, ARGS).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('23514')
    expect(err.message).toContain('23514')
    expect(err.message).not.toContain('secret')
  })

  it('throws when the 23505 open row cannot be read back (nothing was sent)', async () => {
    const db = makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'sent', created_at: NOW.toISOString() }], failSelect: { code: '57014', message: 'timeout' } })
    await expect(beginAttempt(db, ARGS)).rejects.toThrow(/57014/)
  })

  it('throws when the conflicting open row finished before it could be read', async () => {
    // insert collides, but by the time we read, no open row is left
    const db = makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'sent', created_at: NOW.toISOString() }] })
    const realFrom = db.from
    let selects = 0
    db.from = () => {
      const b = realFrom()
      const sel = b.select
      b.select = (c) => { selects++; if (selects > 1) db.table.length = 0; return sel(c) }
      return b
    }
    const err = await beginAttempt(db, ARGS).catch((e) => e)
    expect(err.message).toMatch(/open row/i)
    expect(err.code).toBe('open_row_gone')
  })

  it('an unparsable created_at on a sent row counts as in flight (the safe direction)', async () => {
    const db = makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'sent', created_at: 'not a date' }] })
    expect((await beginAttempt(db, ARGS)).inFlight).toBe(true)
    const db2 = makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'sent', created_at: null }] })
    expect((await beginAttempt(db2, ARGS)).inFlight).toBe(true)
    // still never for an unknown row
    const db3 = makeDb({ rows: [{ id: 'a', idempotency_key: ARGS.key, stage: 'unknown', created_at: 'not a date' }] })
    expect((await beginAttempt(db3, ARGS)).inFlight).toBe(false)
  })

  describe('trial guard', () => {
    const TRIAL = { ...ARGS, op: 'trial', method: 'charge', key: 'trial:loc-1:u1t-user-1:prod-1:charge', target: 'prod-1' }
    it('throws before the insert when the person or product is missing', async () => {
      for (const bad of [{ un1tUserId: undefined }, { un1tUserId: '' }, { target: undefined }, { target: '' }]) {
        const db = makeDb()
        const err = await beginAttempt(db, { ...TRIAL, ...bad }).catch((e) => e)
        expect(err).toBeInstanceOf(TypeError)
        expect(db.log).toHaveLength(0)
      }
    })
    it('throws before the insert when target is not the key\'s product id', async () => {
      const db = makeDb()
      await expect(beginAttempt(db, { ...TRIAL, target: 'prod-2' })).rejects.toThrow(TypeError)
      await expect(beginAttempt(db, { ...TRIAL, key: 'book:loc-1:u1t-user-1:prod-1' })).rejects.toThrow(TypeError)
      expect(db.log).toHaveLength(0)
    })
    it('accepts a matching trial, and non-trial ops need neither', async () => {
      const db = makeDb()
      expect((await beginAttempt(db, TRIAL)).row.target).toBe('prod-1')
      const db2 = makeDb()
      await beginAttempt(db2, { locationId: 'loc-1', op: 'forgot_password', origin: 'staff', key: 'pw:loc-1:u1' })
      expect(db2.log).toHaveLength(1)
    })
  })

  it('refuses a missing location, op, origin or key before touching the db', async () => {
    const db = makeDb()
    await expect(beginAttempt(db, { ...ARGS, key: '' })).rejects.toThrow(TypeError)
    await expect(beginAttempt(db, { ...ARGS, locationId: undefined })).rejects.toThrow(TypeError)
    expect(db.log).toHaveLength(0)
  })
})

describe('finishAttempt', () => {
  it('finishAttempt writes the stage, only the fields given, and finished_at', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent', idempotency_key: 'k', created_at: NOW.toISOString() }] })
    const out = await finishAttempt(db, 'led-1', { stage: 'done', un1tRef: 'bk-9', httpStatus: 201, recovered: 'dedupe_read' })
    expect(out).toBeUndefined()
    expect(db.table[0]).toMatchObject({ stage: 'done', un1t_ref: 'bk-9', http_status: 201, recovered: 'dedupe_read', finished_at: NOW.toISOString() })
    expect('code' in db.table[0]).toBe(false)
    expect('checkout_url' in db.table[0]).toBe(false)
    expect(logError).not.toHaveBeenCalled()
  })

  it('writes the refusal code and message, and the checkout url when given', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }] })
    await finishAttempt(db, 'led-1', { stage: 'refused', httpStatus: 409, code: 'ALREADY_BOOKED', message: 'words', checkoutUrl: 'https://pay.example/c/1' })
    expect(db.table[0]).toMatchObject({ stage: 'refused', http_status: 409, code: 'ALREADY_BOOKED', message: 'words', checkout_url: 'https://pay.example/c/1' })
  })

  it('caps the message at 500 characters so the CHECK cannot refuse the verdict', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }] })
    await finishAttempt(db, 'led-1', { stage: 'refused', message: 'x'.repeat(900) })
    expect(db.table[0].message).toHaveLength(500)
  })

  it('cuts the message on code points, never leaving half an emoji', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }] })
    await finishAttempt(db, 'led-1', { stage: 'refused', message: 'x'.repeat(499) + '\u{1F600}\u{1F600}' })
    const m = db.table[0].message
    expect(Array.from(m)).toHaveLength(500)
    expect(m.endsWith('\u{1F600}')).toBe(true)
    expect(m).toBe(m.toWellFormed())
    // a lone surrogate already in the text is dropped too
    await finishAttempt(db, 'led-1', { stage: 'unknown', message: 'ab\uD83D' })
    expect(db.table[0].message).toBe(db.table[0].message.toWellFormed())
  })

  it('finishAttempt logs a zero-row update, with ids only', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }], updateMatches: false })
    await expect(finishAttempt(db, 'led-1', { stage: 'done', un1tRef: 'bk-9' })).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
    const [mod, , meta] = logError.mock.calls[0]
    expect(mod).toBe('un1t-online-write')
    expect(meta).toEqual({ ledgerId: 'led-1', status: 'done' })
    expect(JSON.stringify(meta)).not.toContain('bk-9')
  })

  it('logs and swallows a DB error, never throws past the caller verdict', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }], failUpdate: { code: '23505', message: 'dup', details: 'Key (idempotency_key)=(secret) exists' } })
    await expect(finishAttempt(db, 'led-1', { stage: 'done' })).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
    const meta = logError.mock.calls[0][2]
    expect(meta).toEqual({ ledgerId: 'led-1', status: 'done', code: '23505' })
    expect(JSON.stringify(meta)).not.toContain('secret')
  })

  it('logs and swallows a thrown client, too', async () => {
    const db = { from() { throw new Error('socket hang up') } }
    await expect(finishAttempt(db, 'led-1', { stage: 'done' })).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][2]).toEqual({ ledgerId: 'led-1' })
  })

  it('refuses nothing silently: a bad stage is logged (without echoing it) and not written', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'sent' }] })
    await finishAttempt(db, 'led-1', { stage: 'bogus-caller-value' })
    expect(db.table[0].stage).toBe('sent')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logError.mock.calls[0])).not.toContain('bogus-caller-value')
  })

  it('refuses stage sent as a finish value, writing nothing', async () => {
    const db = makeDb({ rows: [{ id: 'led-1', stage: 'unknown' }] })
    await finishAttempt(db, 'led-1', { stage: 'sent' })
    expect(db.table[0].stage).toBe('unknown')
    expect(db.log.filter((l) => l.op === 'update')).toHaveLength(0)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('done is final: only sent and unknown rows are updated', async () => {
    const db = makeDb({ rows: [
      { id: 'led-1', stage: 'done', un1t_ref: 'bk-1' },
      { id: 'led-2', stage: 'refused' },
      { id: 'led-3', stage: 'unknown' },
      { id: 'led-4', stage: 'sent' },
    ] })
    await finishAttempt(db, 'led-1', { stage: 'refused', un1tRef: 'other' })
    expect(db.table[0]).toMatchObject({ stage: 'done', un1t_ref: 'bk-1' })
    expect(logError).toHaveBeenCalledTimes(1) // zero rows touched is logged
    await finishAttempt(db, 'led-2', { stage: 'done' })
    expect(db.table[1].stage).toBe('refused')
    await finishAttempt(db, 'led-3', { stage: 'done' })
    await finishAttempt(db, 'led-4', { stage: 'unknown' })
    expect(db.table[2].stage).toBe('done')
    expect(db.table[3].stage).toBe('unknown')
    const upd = db.log.filter((l) => l.op === 'update')
    expect(upd.every((u) => u.filters.some(([k, c, v]) => k === 'in' && c === 'stage' && v.join() === 'sent,unknown'))).toBe(true)
  })
})

describe('findDone and listAttempts', () => {
  const rows = [
    { id: 'a', location_id: 'loc-1', contact_id: 'con-1', op: 'book', idempotency_key: 'k1', stage: 'done', created_at: '2026-10-18T08:00:00.000Z' },
    { id: 'b', location_id: 'loc-1', contact_id: 'con-1', op: 'book', idempotency_key: 'k1', stage: 'done', created_at: '2026-10-18T09:00:00.000Z' },
    { id: 'c', location_id: 'loc-1', contact_id: 'con-1', op: 'book', idempotency_key: 'k1', stage: 'refused', created_at: '2026-10-18T09:30:00.000Z' },
    { id: 'd', location_id: 'loc-1', contact_id: 'con-2', op: 'book', idempotency_key: 'k2', stage: 'done', created_at: '2026-10-18T07:00:00.000Z' },
    { id: 'e', location_id: 'loc-1', contact_id: 'con-1', op: 'create_client', idempotency_key: 'create:loc-1:con-1', stage: 'sent', created_at: '2026-10-18T06:00:00.000Z' },
  ]

  it('findDone returns the latest done row for the key, or null', async () => {
    const db = makeDb({ rows })
    expect((await findDone(db, { key: 'k1' })).id).toBe('b')
    expect(await findDone(db, { key: 'nope' })).toBeNull()
    expect(await findDone(db, { key: 'create:loc-1:con-1' })).toBeNull() // sent is not done
  })

  it('findDone throws on a DB error: a failed read must not read as "not done"', async () => {
    const db = makeDb({ rows, failSelect: { code: '57014', message: 'timeout' } })
    await expect(findDone(db, { key: 'k1' })).rejects.toThrow(/57014/)
  })

  it('listAttempts returns the contact and op rows for the location, newest first', async () => {
    const db = makeDb({ rows })
    const out = await listAttempts(db, { locationId: 'loc-1', contactId: 'con-1', op: 'book' })
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a'])
    const q = db.log.at(-1)
    expect(q.filters).toEqual(expect.arrayContaining([['eq', 'location_id', 'loc-1'], ['eq', 'contact_id', 'con-1'], ['eq', 'op', 'book']]))
    expect(q.limit).toBe(200)
  })

  it('listAttempts throws on a DB error', async () => {
    const db = makeDb({ rows, failSelect: { code: '57014', message: 'timeout' } })
    await expect(listAttempts(db, { locationId: 'loc-1', contactId: 'con-1', op: 'book' })).rejects.toThrow(/57014/)
  })
})
