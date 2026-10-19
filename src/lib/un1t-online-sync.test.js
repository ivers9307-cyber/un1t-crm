import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { runUn1tSync, UN1T_LISTS, STALE_RUN_MS } from './un1t-online-sync.js'
import { logError, logWarn, logInfo } from './log'
import { Un1tAuthError, Un1tApiError } from './un1t-online.js'
import { ilikeMatches } from './like-escape.test-helpers.js'
import { tokenFingerprint } from './un1t-online-token.js'

const ORG = 'org-1'
const HATCH = 'loc-hatch'
const STILLORGAN = 'loc-stillorgan'
const STUDIO = 'studio-hatch'
const NOW = new Date('2026-10-16T10:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const AUTH_MSG =
  'un1t.online token rejected (revoked or expired). Paste a new token in Settings → Integrations → un1t.online.'

// ---------------------------------------------------------------------------
// A recording, in-memory supabase fake. Every terminal operation is logged as
// { table, op, payload, filters, options } so tests can assert on exactly
// which tables were written. Writes resolve { data, error } like PostgREST;
// nothing throws.
// ---------------------------------------------------------------------------
function makeDb(seed = {}, { failUpsert = [], failUpdate = [], failSelect = [], failUpdateIds = [], updateError = null } = {}) {
  const tables = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const log = []
  let seq = 0
  const nextId = (t) => `${t}-${++seq}`
  const rowsOf = (t) => (tables[t] ||= [])

  // `config->>token_id` style JSON paths resolve into the jsonb column.
  const valueOf = (row, col) => {
    if (!col.includes('->>')) return row[col]
    const [root, key] = col.split('->>')
    const v = row[root]?.[key]
    return v == null ? null : String(v)
  }
  function matches(row, filters) {
    return filters.every(([kind, col, val]) => {
      if (kind === 'eq') return valueOf(row, col) === val
      if (kind === 'in') return val.includes(row[col])
      if (kind === 'ilike') return ilikeMatches(val, row[col])
      if (kind === 'lt') return row[col] != null && String(row[col]) < String(val)
      return true
    })
  }

  // Insert-time defaults and triggers the real schema applies.
  function withDefaults(t, row) {
    const out = { id: nextId(t), ...row }
    if (t === 'contacts' && out.organization_id === undefined) {
      const loc = rowsOf('locations').find((l) => l.id === out.location_id)
      out.organization_id = loc ? loc.organization_id : null
    }
    if (t === 'contact_memberships') {
      if (out.first_seen_at === undefined) out.first_seen_at = 'DB_DEFAULT_NOW'
      if (out.created_at === undefined) out.created_at = 'DB_DEFAULT_NOW'
    }
    return out
  }

  function builder(table) {
    const s = { op: 'select', filters: [], payload: null, options: null, order: null, range: null, limit: null, single: false, head: false }
    const run = () => {
      const entry = { table, op: s.op, payload: s.payload, filters: s.filters, options: s.options }
      log.push(entry)
      const rows = rowsOf(table)
      if (s.op === 'select') {
        if (failSelect.includes(table)) return { data: null, error: { message: `${table} read boom` } }
        let out = rows.filter((r) => matches(r, s.filters))
        if (s.head) return { data: null, count: out.length, error: null }
        if (s.order) out = [...out].sort((a, b) => String(a[s.order]).localeCompare(String(b[s.order])))
        if (s.range) out = out.slice(s.range[0], s.range[1] + 1)
        if (s.limit != null) out = out.slice(0, s.limit)
        out = out.map((r) => ({ ...r }))
        if (s.single) return { data: out[0] ?? null, error: null }
        return { data: out, error: null }
      }
      if (s.op === 'insert') {
        const list = Array.isArray(s.payload) ? s.payload : [s.payload]
        // Mig 735: at most one 'running' run per location (partial unique index).
        if (table === 'un1t_sync_runs' && list.some((r) => r.status === 'running'
          && rows.some((x) => x.status === 'running' && x.location_id === r.location_id))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "un1t_sync_runs_one_running"' } }
        }
        const created = list.map((r) => withDefaults(table, r))
        rows.push(...created)
        return { data: created.map((r) => ({ ...r })), error: null }
      }
      if (s.op === 'upsert') {
        if (failUpsert.includes(table)) return { data: null, error: { message: `${table} upsert boom` } }
        const keys = String(s.options?.onConflict || 'id').split(',').map((k) => k.trim())
        const list = Array.isArray(s.payload) ? s.payload : [s.payload]
        const out = []
        for (const r of list) {
          const existing = rows.find((x) => keys.every((k) => x[k] === r[k]))
          if (existing && s.options?.ignoreDuplicates) continue // DO NOTHING: returns no row
          if (existing) {
            Object.assign(existing, r)
            out.push({ ...existing })
          } else {
            const created = withDefaults(table, r)
            rows.push(created)
            out.push({ ...created })
          }
        }
        return { data: out, error: null }
      }
      if (s.op === 'update') {
        if (failUpdate.includes(table)) return { data: null, error: updateError || { message: `${table} update boom` } }
        if (s.filters.some(([k, c, v]) => k === 'eq' && c === 'id' && failUpdateIds.includes(v))) {
          return { data: null, error: { message: 'row update boom' } }
        }
        const hit = rows.filter((r) => matches(r, s.filters))
        for (const r of hit) Object.assign(r, s.payload)
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      if (s.op === 'delete') {
        return { data: null, error: { message: 'delete is not allowed in this fake' } }
      }
      throw new Error(`unknown op ${s.op}`)
    }
    const api = {
      select(_cols, o) { if (o?.head) s.head = true; return api },
      lt(c, v) { s.filters.push(['lt', c, v]); return api },
      insert(p) { s.op = 'insert'; s.payload = p; return api },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o || null; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      delete() { s.op = 'delete'; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      ilike(c, v) { s.filters.push(['ilike', c, v]); return api },
      order(c) { s.order = c; return api },
      range(a, b) { s.range = [a, b]; return api },
      limit(n) { s.limit = n; return api },
      maybeSingle() { s.single = true; return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    return api
  }

  return { db: { from: (t) => builder(t) }, tables, log }
}

const writes = (log) => log.filter((e) => e.op !== 'select')
const writtenTables = (log) => [...new Set(writes(log).map((e) => e.table))].sort()
const upserts = (log, table) => log.filter((e) => e.op === 'upsert' && (!table || e.table === table))

// ---------------------------------------------------------------------------
// A fake un1t.online client.
// ---------------------------------------------------------------------------
function makeClient({ self, selfError, lists = {}, listErrors = {}, truncated = [] } = {}) {
  const calls = []
  const client = {
    async getSelf() {
      calls.push('/api-token')
      if (selfError) throw selfError
      return self
    },
    async listAll(path) {
      calls.push(path)
      if (listErrors[path]) throw listErrors[path]
      const rows = lists[path] || []
      return { rows, total: rows.length, truncated: truncated.includes(path) }
    },
    stats() { return { requests: calls.length, waitedMs: 0, retries: 0 } },
  }
  const factory = vi.fn(() => client)
  return { factory, calls }
}

const SELF = {
  id: 'tok-1',
  name: 'CRM read-only',
  expires_at: '2027-04-01T00:00:00.000Z',
  studio: { id: STUDIO, title: 'UN1T Hatch Street' },
  permissions: ['clients:read'],
}

function fixtureLists() {
  return {
    '/products': [
      { id: 'p1', title: 'Unlimited', studio_id: STUDIO, price_amount: 12000 },
      { id: 'p2', title: '10 pack', studio_id: STUDIO },
    ],
    '/events': [{ id: 'e1', title: 'HYROX', studio_id: STUDIO, status: 'scheduled', start_time: '2026-10-20T17:30:00Z', end_time: '2026-10-20T18:30:00Z' }],
    '/users/clients': [
      { id: 'u1', email: 'one@x.ie', first_name: 'One', studio: { id: STUDIO } },
      { id: 'u2', email: 'two@x.ie', first_name: 'Two', studio: { id: STUDIO } },
      { id: 'u3', email: 'three@x.ie', first_name: 'Three' },
    ],
    '/subscriptions': [
      { id: 's1', user_id: 'u1', status: 'active', product: { id: 'p1', title: 'Unlimited' }, studio_id: STUDIO },
      { id: 's2', user_id: 'u2', status: 'canceled', product: { id: 'p1', title: 'Unlimited' }, studio_id: STUDIO },
    ],
    '/transactions': [{ id: 't1', user_id: 'u1', amount: 12000, studio_id: STUDIO }],
    '/invoices': [{ id: 'i1', user_id: 'u1', amount: 12000, studio_id: STUDIO }],
    '/bookings': [
      // un1t.online always sends a status (UserBookingResponseDto); a row
      // without one is not projected into class_bookings (UN1TBOOK.16).
      { id: 'b1', user_id: 'u1', event_id: 'e1', status: 'booked', studio_id: STUDIO },
      { id: 'b2', user_id: 'u2', event_id: 'e1', status: 'booked', studio_id: STUDIO },
    ],
  }
}

function baseSeed(extra = {}) {
  return {
    locations: [
      { id: HATCH, organization_id: ORG, membership_source: 'un1t_online' },
      { id: STILLORGAN, organization_id: ORG },
    ],
    channel_connections: [
      {
        id: 'cc-1',
        location_id: HATCH,
        platform: 'un1t_online',
        is_active: true,
        status: 'connected',
        access_token: 'un1t_secret_token_value',
        external_account_id: STUDIO,
        config: { token_id: 'tok-1', token_name: 'CRM read-only', token_fingerprint: tokenFingerprint('un1t_secret_token_value') },
      },
    ],
    contacts: [],
    contact_memberships: [],
    ...extra,
  }
}

const opts = (factory, now = NOW) => ({ clientFactory: factory, now: () => now })
const connRow = (tables) => tables.channel_connections.find((c) => c.id === 'cc-1')
const runRow = (tables) => tables.un1t_sync_runs[tables.un1t_sync_runs.length - 1]

describe('runUn1tSync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists every un1t.online collection', () => {
    expect(UN1T_LISTS).toEqual(['/products', '/events', '/users/clients', '/subscriptions', '/transactions', '/invoices', '/bookings'])
    expect(Object.isFrozen(UN1T_LISTS)).toBe(true)
  })

  it('happy path writes every table and marks the connection connected', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const lists = fixtureLists()
    const { factory } = makeClient({ self: SELF, lists })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.runId).toBeTruthy()
    expect(factory).toHaveBeenCalledWith({ token: 'un1t_secret_token_value' })

    expect(r.counts.tables).toEqual({
      un1t_products: lists['/products'].length,
      un1t_events: lists['/events'].length,
      un1t_clients: lists['/users/clients'].length,
      un1t_subscriptions: lists['/subscriptions'].length,
      un1t_transactions: lists['/transactions'].length,
      un1t_invoices: lists['/invoices'].length,
      un1t_bookings: lists['/bookings'].length,
    })
    expect(tables.un1t_products).toHaveLength(2)
    expect(tables.un1t_bookings).toHaveLength(2)

    // Upsert order and conflict keys.
    const order = upserts(log).map((e) => [e.table, e.options.onConflict])
    expect(order).toEqual([
      ['un1t_products', 'location_id,un1t_id'],
      ['un1t_events', 'location_id,un1t_id'],
      ['class_occurrences', 'location_id,glofox_event_id'],
      ['un1t_clients', 'location_id,un1t_user_id'],
      ['un1t_subscriptions', 'location_id,un1t_id'],
      ['un1t_transactions', 'location_id,un1t_id'],
      ['un1t_invoices', 'location_id,un1t_id'],
      ['un1t_bookings', 'location_id,un1t_id'],
      ['class_bookings', 'location_id,glofox_booking_id'],
      ['contact_memberships', 'contact_id,location_id,source'],
    ])

    // contact_id filled from the resolver.
    const c1 = tables.contacts.find((c) => c.un1t_user_id === 'u1')
    expect(tables.un1t_clients.find((c) => c.un1t_user_id === 'u1').contact_id).toBe(c1.id)
    expect(tables.un1t_subscriptions.find((s) => s.un1t_id === 's1').contact_id).toBe(c1.id)
    expect(tables.un1t_bookings.find((b) => b.un1t_id === 'b1').contact_id).toBe(c1.id)
    expect(tables.un1t_transactions[0].contact_id).toBe(c1.id)
    expect(tables.un1t_invoices[0].contact_id).toBe(c1.id)
    expect(r.counts.contacts.created).toBe(3)

    // Membership: only the active subscription.
    const memUpsert = upserts(log, 'contact_memberships')[0]
    expect(memUpsert.payload).toEqual([
      {
        organization_id: ORG,
        location_id: HATCH,
        contact_id: c1.id,
        source: 'un1t_online_api',
        plan_name: 'Unlimited',
        status: 'active',
        ended_at: null,
        last_seen_at: NOW_ISO,
        updated_at: NOW_ISO,
      },
    ])
    // first_seen_at is never in the payload, so the insert default sets it once.
    expect(memUpsert.payload[0]).not.toHaveProperty('first_seen_at')
    expect(tables.contact_memberships).toHaveLength(1)
    expect(r.counts.memberships).toMatchObject({ active: 1, ended: 0 })

    // Connection.
    const conn = connRow(tables)
    expect(conn.status).toBe('connected')
    expect(conn.last_ok_at).toBe(NOW_ISO)
    expect(conn.last_error).toBeNull()
    const connUpdate = log.find((e) => e.table === 'channel_connections' && e.op === 'update')
    expect(connUpdate.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'location_id', HATCH],
        ['eq', 'platform', 'un1t_online'],
        ['eq', 'is_active', true],
        ['eq', 'config->>token_fingerprint', tokenFingerprint('un1t_secret_token_value')],
      ]),
    )
    // The token is never a filter value (filters are URL query parameters).
    expect(JSON.stringify(log.map((e) => e.filters))).not.toContain('un1t_secret_token_value')

    // Run row.
    const run = runRow(tables)
    expect(run.id).toBe(r.runId)
    expect(run.status).toBe('ok')
    expect(run.finished_at).toBe(NOW_ISO)
    expect(run.duration_ms).toBe(0)
    expect(run.first_error).toBeNull()
    expect(run.counts).toEqual(r.counts)
    expect(r.counts.api).toEqual({ requests: 8, waitedMs: 0, retries: 0 })

    // The token never reaches the run row or the result.
    expect(JSON.stringify(run)).not.toContain('un1t_secret_token_value')
    expect(JSON.stringify(r)).not.toContain('un1t_secret_token_value')
  })

  it('records token_expires_at from /api-token', async () => {
    const { db, tables } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    await runUn1tSync(db, HATCH, opts(factory))
    expect(connRow(tables).token_expires_at).toBe('2027-04-01T00:00:00.000Z')
  })

  it('401 marks action_needed and writes no table', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const { factory, calls } = makeClient({ selfError: new Un1tAuthError('refused', 401) })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'auth' })
    expect(r.runId).toBeTruthy()
    expect(calls).toEqual(['/api-token'])
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    const conn = connRow(tables)
    expect(conn.status).toBe('action_needed')
    expect(conn.last_error).toBe(AUTH_MSG)
    expect(conn.access_token).toBe('un1t_secret_token_value')
    expect(runRow(tables).status).toBe('error')
    expect(runRow(tables).first_error).toBeTruthy()
  })

  it('a 401 part-way through the lists is auth too, with nothing written', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const { factory } = makeClient({
      self: SELF,
      lists: fixtureLists(),
      listErrors: { '/transactions': new Un1tAuthError('refused', 401) },
    })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r).toMatchObject({ ok: false, reason: 'auth' })
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    expect(connRow(tables).status).toBe('action_needed')
  })

  it('token studio differs from stored studio → studio_mismatch, no table writes', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const { factory, calls } = makeClient({
      self: { ...SELF, studio: { id: 'studio-other', title: 'Elsewhere' } },
      lists: fixtureLists(),
    })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'studio_mismatch' })
    expect(calls).toEqual(['/api-token'])
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    const conn = connRow(tables)
    expect(conn.status).toBe('error')
    expect(conn.last_error).toContain('studio-other')
    expect(conn.last_error).toContain(STUDIO)
    // A token for another studio does not get its expiry recorded here.
    expect(conn.token_expires_at).toBeUndefined()
    expect(runRow(tables).status).toBe('error')
  })

  it('a row from another studio → studio_mismatch, no table writes', async () => {
    const lists = fixtureLists()
    lists['/bookings'] = [...lists['/bookings'], { id: 'b9', user_id: 'u1', studio_id: 'studio-other' }]
    const { db, tables, log } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'studio_mismatch' })
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    expect(tables.contacts).toHaveLength(0)
    const conn = connRow(tables)
    expect(conn.status).toBe('error')
    expect(conn.last_error).toContain('studio-other')
    expect(conn.last_error).toContain(STUDIO)
  })

  it('a client row from another studio is caught by its nested studio id', async () => {
    const lists = fixtureLists()
    lists['/users/clients'] = [...lists['/users/clients'], { id: 'u9', email: 'x@y.ie', studio: { id: 'studio-other' } }]
    const { db, log } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.reason).toBe('studio_mismatch')
    expect(upserts(log)).toHaveLength(0)
  })

  it('a list that fails mid-walk writes nothing', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const { factory, calls } = makeClient({
      self: SELF,
      lists: fixtureLists(),
      listErrors: { [UN1T_LISTS[2]]: new Un1tApiError('HTTP 500 after 3 retries', { status: 500 }) },
    })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'api' })
    expect(upserts(log)).toHaveLength(0)
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    expect(calls).toEqual(['/api-token', '/products', '/events', '/users/clients'])
    const conn = connRow(tables)
    expect(conn.status).toBe('error')
    expect(conn.last_error).toContain('/users/clients')
    expect(runRow(tables).first_error).toContain('/users/clients')
  })

  it('truncated list refuses the run', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists: fixtureLists(), truncated: ['/bookings'] })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'truncated' })
    expect(upserts(log)).toHaveLength(0)
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
    expect(connRow(tables).status).toBe('error')
    expect(connRow(tables).last_error).toContain('/bookings')
  })

  it('no active connection → not_connected; the connection is untouched', async () => {
    const seed = baseSeed()
    seed.channel_connections[0].is_active = false
    const { db, tables, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(factory).not.toHaveBeenCalled()
    expect(writtenTables(log)).toEqual(['un1t_sync_runs'])
    expect(runRow(tables).status).toBe('error')
  })

  it('an active row with no token → not_connected', async () => {
    const seed = baseSeed()
    seed.channel_connections[0].access_token = null
    const { db, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.reason).toBe('not_connected')
    expect(factory).not.toHaveBeenCalled()
    expect(writtenTables(log)).toEqual(['un1t_sync_runs'])
  })

  it('a failed registry read is db, never not_connected', async () => {
    const { db, log } = makeDb(baseSeed(), { failSelect: ['channel_connections'] })
    const { factory } = makeClient({ self: SELF })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r).toMatchObject({ ok: false, reason: 'db' })
    expect(factory).not.toHaveBeenCalled()
    expect(writtenTables(log)).toEqual(['un1t_sync_runs'])
  })

  it('first upsert failure stops later tables and reports db', async () => {
    const { db, tables, log } = makeDb(baseSeed(), { failUpsert: ['un1t_products'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r).toMatchObject({ ok: false, reason: 'db' })
    expect(upserts(log).map((e) => e.table)).toEqual(['un1t_products'])
    expect(log.some((e) => e.table === 'contact_memberships' && e.op !== 'select')).toBe(false)
    const conn = connRow(tables)
    expect(conn.status).toBe('error')
    expect(conn.last_error).toContain('un1t_products')
    expect(runRow(tables).status).toBe('error')
    expect(runRow(tables).first_error).toContain('un1t_products')
  })

  it('a later upsert failure leaves the earlier tables written and stops there', async () => {
    const { db, log } = makeDb(baseSeed(), { failUpsert: ['un1t_subscriptions'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.reason).toBe('db')
    expect(upserts(log).map((e) => e.table)).toEqual(['un1t_products', 'un1t_events', 'class_occurrences', 'un1t_clients', 'un1t_subscriptions'])
  })

  describe('class_occurrences projection (UN1TCLASS.2)', () => {
    it('projects the pulled events and counts them', async () => {
      const { db, tables } = makeDb(baseSeed())
      const lists = fixtureLists()
      lists['/events'] = [
        { id: 'e1', title: 'HYROX', studio_id: STUDIO, status: 'scheduled', start_time: '2026-10-20T17:30:00Z', end_time: '2026-10-20T18:30:00Z', clients_limit: 14 },
        { id: 'e2', title: 'Strength', studio_id: STUDIO, status: 'cancelled', start_time: '2026-10-21T17:30:00Z', end_time: '2026-10-21T18:30:00Z' },
      ]
      const { factory } = makeClient({ self: SELF, lists })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.class_occurrences).toEqual({ upserted: 2 })
      expect(tables.class_occurrences.map((o) => o.glofox_event_id).sort()).toEqual(['un1t:e1', 'un1t:e2'])
      expect(tables.class_occurrences.every((o) => o.source_platform === 'un1t_online' && o.location_id === HATCH)).toBe(true)
      expect(tables.class_occurrences.find((o) => o.glofox_event_id === 'un1t:e2').cancelled_at).toBe(NOW_ISO)
      expect(runRow(tables).counts.class_occurrences).toEqual({ upserted: 2 })
    })

    it('a projection failure leaves the run ok and the connection connected, with counts.class_occurrences.error', async () => {
      const { db, tables } = makeDb(baseSeed(), { failUpsert: ['class_occurrences'] })
      const lists = fixtureLists()
      lists['/events'] = [{ id: 'e1', title: 'HYROX', studio_id: STUDIO, status: 'scheduled', start_time: '2026-10-20T17:30:00Z', end_time: '2026-10-20T18:30:00Z' }]
      const { factory } = makeClient({ self: SELF, lists })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.reason).toBeUndefined()
      expect(r.counts.class_occurrences).toEqual({ error: { code: null, message: 'class_occurrences upsert boom' } })
      expect(connRow(tables).status).toBe('connected')
      expect(connRow(tables).last_error).toBeNull()
      expect(runRow(tables).status).toBe('ok')
      expect(runRow(tables).counts.class_occurrences.error).toBeTruthy()
      // The rest of the run carried on: later tables and memberships still wrote.
      expect(tables.un1t_bookings).toHaveLength(2)
      expect(tables.contact_memberships).toHaveLength(1)
      expect(logWarn).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('class_occurrences'), expect.objectContaining({ err: { code: null, message: 'class_occurrences upsert boom' } }))
      // The bookings projection is independent of the occurrences one.
      expect(tables.class_bookings).toHaveLength(2)
      expect(r.counts.class_bookings).toEqual({ upserted: 2, skipped_no_event: 0, skipped_unknown_status: 0 })
    })

    it('does not project when the un1t_events upsert fails (the run stops with db)', async () => {
      const { db, log } = makeDb(baseSeed(), { failUpsert: ['un1t_events'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r).toMatchObject({ ok: false, reason: 'db' })
      expect(log.some((e) => e.table === 'class_occurrences')).toBe(false)
      expect(r.counts.class_occurrences).toBeUndefined()
    })

    it('a studio whose membership_source is glofox is NOT projected: skipped is recorded, status unchanged (UN1TCLASS.5)', async () => {
      const seed = baseSeed()
      seed.locations = seed.locations.map((l) => (l.id === HATCH ? { ...l, membership_source: 'glofox' } : l))
      const { db, tables, log } = makeDb(seed)
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.class_occurrences).toEqual({ skipped: 'membership_source' })
      expect(log.some((e) => e.table === 'class_occurrences')).toBe(false)
      expect(runRow(tables).status).toBe('ok')
      expect(runRow(tables).counts.class_occurrences).toEqual({ skipped: 'membership_source' })
      expect(connRow(tables).status).toBe('connected')
      expect(tables.contact_memberships).toHaveLength(1)
    })
  })

  describe('class_bookings projection (UN1TBOOK.3)', () => {
    it('a un1t_online studio projects its bookings after un1t_bookings is written', async () => {
      const { db, tables, log } = makeDb(baseSeed())
      const lists = fixtureLists()
      lists['/bookings'] = [
        { id: 'b1', user_id: 'u1', event_id: 'e1', status: 'attended', source: 'app', credit_charged: true, studio_id: STUDIO, guest_email: 'g@x.ie' },
        { id: 'b2', user_id: 'u2', event_id: 'e1', status: 'cancelled', studio_id: STUDIO },
      ]
      const { factory } = makeClient({ self: SELF, lists })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.class_bookings).toEqual({ upserted: 2, skipped_no_event: 0, skipped_unknown_status: 0 })
      expect(runRow(tables).counts.class_bookings).toEqual({ upserted: 2, skipped_no_event: 0, skipped_unknown_status: 0 })

      const tablesInOrder = upserts(log).map((e) => e.table)
      expect(tablesInOrder.indexOf('class_bookings')).toBe(tablesInOrder.indexOf('un1t_bookings') + 1)

      const c1 = tables.contacts.find((c) => c.un1t_user_id === 'u1')
      const b1 = tables.class_bookings.find((b) => b.glofox_booking_id === 'un1t:b1')
      expect(b1).toMatchObject({
        location_id: HATCH,
        glofox_event_id: 'un1t:e1',
        glofox_member_id: null,
        source_platform: 'un1t_online',
        contact_id: c1.id,
        member_name: c1.name,
        class_name: 'HYROX',
        starts_at: '2026-10-20T17:30:00Z',
        status: 'ATTENDED',
        attended: true,
        raw: { un1t: { status: 'attended', source: 'app', credit_charged: true, has_guest: true, updated_at: null, written_by: 'sync' } },
        synced_at: NOW_ISO,
      })
      expect(tables.class_bookings.find((b) => b.glofox_booking_id === 'un1t:b2')).toMatchObject({ status: 'CANCELLED', attended: false })
      expect(log.some((e) => e.table === 'class_bookings' && (e.op === 'delete' || e.op === 'update'))).toBe(false)
    })

    it('a glofox studio is skipped: { skipped: \'membership_source\' }', async () => {
      const seed = baseSeed()
      seed.locations = seed.locations.map((l) => (l.id === HATCH ? { ...l, membership_source: 'glofox' } : l))
      const { db, tables, log } = makeDb(seed)
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.class_bookings).toEqual({ skipped: 'membership_source' })
      expect(log.some((e) => e.table === 'class_bookings')).toBe(false)
      expect(writtenTables(log)).not.toContain('class_bookings')
      expect(tables.un1t_bookings).toHaveLength(2)
    })

    it('a projection failure leaves the run ok, the connection connected, memberships written, and counts.class_bookings.error set', async () => {
      const { db, tables } = makeDb(baseSeed(), { failUpsert: ['class_bookings'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.reason).toBeUndefined()
      expect(r.counts.class_bookings).toEqual({ error: { code: null, message: 'class_bookings upsert boom' } })
      expect(runRow(tables).status).toBe('ok')
      expect(runRow(tables).first_error).toBeNull()
      expect(runRow(tables).counts.class_bookings.error).toBeTruthy()
      expect(connRow(tables).status).toBe('connected')
      expect(connRow(tables).last_error).toBeNull()
      expect(tables.un1t_bookings).toHaveLength(2)
      expect(tables.contact_memberships).toHaveLength(1)
      expect(r.counts.memberships).toMatchObject({ active: 1 })
      expect(logWarn).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('class_bookings'), expect.objectContaining({ err: { code: null, message: 'class_bookings upsert boom' } }))
    })

    it('does not project when the un1t_bookings upsert fails (the run stops with db)', async () => {
      const { db, log } = makeDb(baseSeed(), { failUpsert: ['un1t_bookings'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r).toMatchObject({ ok: false, reason: 'db' })
      expect(log.some((e) => e.table === 'class_bookings')).toBe(false)
      expect(r.counts.class_bookings).toBeUndefined()
    })
  })

  it('upserts in chunks of 200', async () => {
    const lists = fixtureLists()
    lists['/events'] = Array.from({ length: 450 }, (_, i) => ({ id: `e${i}`, studio_id: STUDIO }))
    const { db, tables, log } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(upserts(log, 'un1t_events').map((e) => e.payload.length)).toEqual([200, 200, 50])
    expect(tables.un1t_events).toHaveLength(450)
    expect(r.counts.tables.un1t_events).toBe(450)
  })

  it('a subscription gone from the pull ends its membership', async () => {
    const seed = baseSeed({
      contacts: [{ id: 'c-gone', organization_id: ORG, location_id: HATCH, email: 'gone@x.ie', un1t_user_id: 'u-gone' }],
      contact_memberships: [
        {
          id: 'm-gone', organization_id: ORG, location_id: HATCH, contact_id: 'c-gone', source: 'un1t_online_api',
          plan_name: 'Unlimited', status: 'active', ended_at: null, first_seen_at: '2026-09-01T00:00:00.000Z',
          last_seen_at: '2026-10-15T00:00:00.000Z',
        },
      ],
    })
    const { db, tables, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r.ok).toBe(true)
    const row = tables.contact_memberships.find((m) => m.id === 'm-gone')
    expect(row.status).toBe('ended')
    expect(row.ended_at).toBe(NOW_ISO)
    expect(row.first_seen_at).toBe('2026-09-01T00:00:00.000Z')
    const endUpdate = log.find((e) => e.table === 'contact_memberships' && e.op === 'update')
    expect(endUpdate.payload).toMatchObject({ status: 'ended', ended_at: NOW_ISO })
    expect(endUpdate.filters).toEqual(expect.arrayContaining([['eq', 'status', 'active']]))
    expect(r.counts.memberships.ended).toBe(1)
    expect(log.some((e) => e.op === 'delete')).toBe(false)
  })

  it('a cancelled subscription ends the membership; a reactivated one re-activates the same row', async () => {
    const { db, tables, log } = makeDb(baseSeed())
    const lists = fixtureLists()

    // Run 1: s1 active → one active row.
    await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists }).factory, new Date('2026-10-16T10:00:00.000Z')))
    expect(tables.contact_memberships).toHaveLength(1)
    const rowId = tables.contact_memberships[0].id
    expect(tables.contact_memberships[0].status).toBe('active')

    // Run 2: s1 cancelled → ended.
    const cancelled = fixtureLists()
    cancelled['/subscriptions'][0].status = 'canceled'
    await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists: cancelled }).factory, new Date('2026-10-17T10:00:00.000Z')))
    expect(tables.contact_memberships).toHaveLength(1)
    expect(tables.contact_memberships[0]).toMatchObject({ id: rowId, status: 'ended', ended_at: '2026-10-17T10:00:00.000Z' })

    // Run 3: s1 active again → the same row, active, ended_at cleared.
    const back = fixtureLists()
    await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists: back }).factory, new Date('2026-10-18T10:00:00.000Z')))
    expect(tables.contact_memberships).toHaveLength(1)
    expect(tables.contact_memberships[0]).toMatchObject({
      id: rowId,
      status: 'active',
      ended_at: null,
      last_seen_at: '2026-10-18T10:00:00.000Z',
      first_seen_at: 'DB_DEFAULT_NOW',
    })
    const lastUpsert = upserts(log, 'contact_memberships').at(-1)
    expect(lastUpsert.options.onConflict).toBe('contact_id,location_id,source')
    expect(lastUpsert.payload[0]).toMatchObject({ status: 'active', ended_at: null })
    expect(log.some((e) => e.op === 'delete')).toBe(false)
  })

  it('export-source membership rows are untouched', async () => {
    const seed = baseSeed({
      contacts: [{ id: 'c-exp', organization_id: ORG, location_id: HATCH, email: 'exp@x.ie', un1t_user_id: null }],
      contact_memberships: [
        {
          id: 'm-exp', organization_id: ORG, location_id: HATCH, contact_id: 'c-exp', source: 'un1t_online_export',
          plan_name: 'Founding', status: 'active', ended_at: null, first_seen_at: 'x', last_seen_at: 'x',
        },
      ],
    })
    const { db, tables, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })

    const r = await runUn1tSync(db, HATCH, opts(factory))

    expect(r.ok).toBe(true)
    expect(tables.contact_memberships.find((m) => m.id === 'm-exp')).toMatchObject({ status: 'active', ended_at: null, plan_name: 'Founding' })
    // Every membership read and write is scoped to the api source.
    for (const e of log.filter((x) => x.table === 'contact_memberships' && x.op !== 'upsert')) {
      expect(e.filters).toEqual(expect.arrayContaining([['eq', 'source', 'un1t_online_api'], ['eq', 'location_id', HATCH]]))
    }
  })

  it('an active subscription whose user has no contact is skipped and counted', async () => {
    const lists = fixtureLists()
    lists['/subscriptions'].push({ id: 's9', user_id: 'u-unknown', status: 'active', product: { title: 'Unlimited' }, studio_id: STUDIO })
    const { db, tables } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.memberships.skipped_no_contact).toBe(1)
    expect(tables.contact_memberships).toHaveLength(1)
    expect(tables.un1t_subscriptions.find((s) => s.un1t_id === 's9').contact_id).toBeNull()
  })

  describe('contact-resolution problems on an otherwise ok run', () => {
    it('stays connected but records a counts-only last_error', async () => {
      const seed = baseSeed({
        contacts: [
          { id: 'c-fail', organization_id: ORG, location_id: HATCH, email: 'one@x.ie', un1t_user_id: 'u1', first_name: null, last_name: 'One', phone: '+353870000001' },
        ],
      })
      const { db, tables } = makeDb(seed, { failUpdateIds: ['c-fail'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      const conn = connRow(tables)
      expect(conn.status).toBe('connected')
      expect(conn.last_error).toBe('Synced, but 1 un1t.online member could not be matched to contacts (1 failed, 0 conflicts, 0 ambiguous emails).')
      expect(conn.last_error).not.toContain('one@x.ie')
    })

    it('a clean run leaves last_error null (and clears an earlier warning)', async () => {
      const seed = baseSeed()
      seed.channel_connections[0].last_error = 'Synced, but 1 un1t.online member could not be matched to contacts (1 failed, 0 conflicts, 0 ambiguous emails).'
      const { db, tables } = makeDb(seed)
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(connRow(tables).last_error).toBeNull()
    })
  })

  describe('an active subscription whose user is missing from the client pull', () => {
    const seed = () =>
      baseSeed({
        contacts: [
          { id: 'c-ghost', organization_id: ORG, location_id: HATCH, email: 'ghost@x.ie', un1t_user_id: 'u-ghost', first_name: 'Ghost', last_name: 'G', phone: '+353870000009' },
          { id: 'c-gone', organization_id: ORG, location_id: HATCH, email: 'gone@x.ie', un1t_user_id: 'u-gone', first_name: 'Gone', last_name: 'G', phone: '+353870000008' },
        ],
        contact_memberships: [
          { id: 'm-ghost', organization_id: ORG, location_id: HATCH, contact_id: 'c-ghost', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
          { id: 'm-gone', organization_id: ORG, location_id: HATCH, contact_id: 'c-gone', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
        ],
      })

    it("does not end that user's contact's existing active membership, but still ends an unrelated one", async () => {
      const lists = fixtureLists()
      lists['/subscriptions'].push({ id: 's-ghost', user_id: 'u-ghost', status: 'active', product: { title: 'Unlimited' }, studio_id: STUDIO })
      const { db, tables } = makeDb(seed())
      const { factory } = makeClient({ self: SELF, lists })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(tables.contact_memberships.find((m) => m.id === 'm-ghost')).toMatchObject({ status: 'active', ended_at: null })
      expect(tables.contact_memberships.find((m) => m.id === 'm-gone')).toMatchObject({ status: 'ended', ended_at: NOW_ISO })
      expect(r.counts.memberships.end_skipped_unresolved).toBe(1)
    })

    it('freezes every ending when an active subscription carries no user id at all', async () => {
      const lists = fixtureLists()
      lists['/subscriptions'].push({ id: 's-null', user_id: null, status: 'active', product: { title: 'Unlimited' }, studio_id: STUDIO })
      const { db, tables } = makeDb(seed())
      const { factory } = makeClient({ self: SELF, lists })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(tables.contact_memberships.find((m) => m.id === 'm-gone').status).toBe('active')
      expect(tables.contact_memberships.find((m) => m.id === 'm-ghost').status).toBe('active')
      expect(r.counts.memberships).toMatchObject({ end_skipped: 'contacts_unresolved', ended: 0 })
      expect(r.counts.memberships.would_end).toBeGreaterThan(0)
    })
  })

  it('a plan with no product title is recorded as Membership', async () => {
    const lists = fixtureLists()
    lists['/subscriptions'][0].product = null
    const { db, tables } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })
    await runUn1tSync(db, HATCH, opts(factory))
    expect(tables.contact_memberships[0].plan_name).toBe('Membership')
  })

  it('a failed contacts read leaves every membership active this run (unknown is not cancelled)', async () => {
    const seed = baseSeed({
      contact_memberships: [
        { id: 'm-old', organization_id: ORG, location_id: HATCH, contact_id: 'c-old', source: 'un1t_online_api', plan_name: 'X', status: 'active', ended_at: null },
      ],
    })
    // Every contacts read fails → every client fails to resolve, and the read
    // that would pick out their contacts fails too.
    const { db, tables } = makeDb(seed, { failSelect: ['contacts'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(tables.contact_memberships.find((m) => m.id === 'm-old').status).toBe('active')
    expect(r.counts.memberships.end_skipped).toBe('contacts_unreadable')
    expect(r.counts.contacts.failed).toBe(3)
  })

  describe('one client that keeps failing to resolve', () => {
    // u1 is linked to c-fail and has a null first_name, so the resolver's
    // null-fill UPDATE runs — and is rejected on every run. u2 is linked to
    // c-other (nothing to fill) and its subscription s2 is cancelled.
    const seed = () =>
      baseSeed({
        contacts: [
          { id: 'c-fail', organization_id: ORG, location_id: HATCH, email: 'one@x.ie', un1t_user_id: 'u1', first_name: null, last_name: 'One', phone: '+353870000001' },
          { id: 'c-other', organization_id: ORG, location_id: HATCH, email: 'two@x.ie', un1t_user_id: 'u2', first_name: 'Two', last_name: 'Two', phone: '+353870000002' },
        ],
        contact_memberships: [
          { id: 'm-fail', organization_id: ORG, location_id: HATCH, contact_id: 'c-fail', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
          { id: 'm-other', organization_id: ORG, location_id: HATCH, contact_id: 'c-other', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
        ],
      })

    it("still ends a DIFFERENT contact's cancelled membership", async () => {
      const { db, tables } = makeDb(seed(), { failUpdateIds: ['c-fail'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.contacts.failed).toBe(1)
      expect(tables.contact_memberships.find((m) => m.id === 'm-other')).toMatchObject({ status: 'ended', ended_at: NOW_ISO })
      expect(r.counts.memberships.ended).toBe(1)
      expect(r.counts.memberships.end_skipped).toBeUndefined()
    })

    it("does not end the failed client's own active membership", async () => {
      const { db, tables } = makeDb(seed(), { failUpdateIds: ['c-fail'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(tables.contact_memberships.find((m) => m.id === 'm-fail')).toMatchObject({ status: 'active', ended_at: null })
      expect(r.counts.memberships.end_skipped_unresolved).toBe(1)
      // Its active subscription could not be attributed this run.
      expect(r.counts.memberships.skipped_no_contact).toBe(1)
    })

    it('keeps doing so on every run while the failure persists', async () => {
      const { db, tables } = makeDb(seed(), { failUpdateIds: ['c-fail'] })
      for (const day of ['2026-10-16', '2026-10-17']) {
        await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists: fixtureLists() }).factory, new Date(`${day}T10:00:00.000Z`)))
      }
      expect(tables.contact_memberships.find((m) => m.id === 'm-fail').status).toBe('active')
      expect(tables.contact_memberships.find((m) => m.id === 'm-other').status).toBe('ended')
    })
  })

  it('does not end every membership on an empty subscription pull', async () => {
    const seed = baseSeed({
      contact_memberships: [
        { id: 'm-old', organization_id: ORG, location_id: HATCH, contact_id: 'c-old', source: 'un1t_online_api', plan_name: 'X', status: 'active', ended_at: null },
      ],
    })
    const lists = fixtureLists()
    lists['/subscriptions'] = []
    const { db, tables } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(tables.contact_memberships.find((m) => m.id === 'm-old').status).toBe('active')
    expect(r.counts.memberships.end_skipped).toBe('no_subscriptions_pulled')
  })

  it('a failed membership end is db', async () => {
    const seed = baseSeed({
      contact_memberships: [
        { id: 'm-old', organization_id: ORG, location_id: HATCH, contact_id: 'c-old', source: 'un1t_online_api', plan_name: 'X', status: 'active', ended_at: null },
      ],
    })
    const { db, tables } = makeDb(seed, { failUpdate: ['contact_memberships'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r).toMatchObject({ ok: false, reason: 'db' })
    expect(connRow(tables).last_error).toContain('contact_memberships')
  })

  it('a failed connection or run-row bookkeeping write does not change the result', async () => {
    const { db } = makeDb(baseSeed(), { failUpdate: ['channel_connections', 'un1t_sync_runs'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
  })

  it('a missing organisation is db, before any contact write', async () => {
    const seed = baseSeed()
    seed.locations = []
    const { db, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r).toMatchObject({ ok: false, reason: 'db' })
    expect(writtenTables(log)).toEqual(['channel_connections', 'un1t_sync_runs'])
  })

  describe('the token is replaced while a run is in flight', () => {
    // The connect route replaces the token in place: same row, new token and
    // new token_id. Simulated inside the fake client, mid-run.
    const swap = (tables) => {
      const row = tables.channel_connections.find((c) => c.id === 'cc-1')
      row.access_token = 'un1t_new_token_value'
      row.config = { token_id: 'tok-2', token_fingerprint: tokenFingerprint('un1t_new_token_value') }
      row.status = 'connected'
      row.last_error = null
    }

    it('an old-token 401 does not mark the new token action_needed', async () => {
      const { db, tables } = makeDb(baseSeed())
      const client = {
        async getSelf() { swap(tables); throw new Un1tAuthError('refused', 401) },
        async listAll() { throw new Error('not reached') },
        stats: () => ({ requests: 1, waitedMs: 0, retries: 0 }),
      }
      const r = await runUn1tSync(db, HATCH, opts(() => client))
      expect(r).toMatchObject({ ok: false, reason: 'auth' })
      expect(connRow(tables)).toMatchObject({ status: 'connected', last_error: null, access_token: 'un1t_new_token_value' })
      expect(r.counts.connection_update_skipped).toBe('superseded')
      expect(r.counts.connection_update_error).toBeUndefined()
      expect(runRow(tables).status).toBe('error')
      expect(logWarn).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('connection changed'), expect.any(Object))
      expect(JSON.stringify([logWarn.mock.calls, logError.mock.calls])).not.toContain('un1t_new_token_value')
      expect(JSON.stringify([logWarn.mock.calls, logError.mock.calls])).not.toContain('un1t_secret_token_value')
    })

    it('an old-token success does not stamp last_ok_at or the old expiry on the new token', async () => {
      const { db, tables } = makeDb(baseSeed())
      const lists = fixtureLists()
      const client = {
        async getSelf() { return SELF },
        async listAll(path) {
          if (path === '/bookings') swap(tables)
          return { rows: lists[path], total: lists[path].length, truncated: false }
        },
        stats: () => ({ requests: 8, waitedMs: 0, retries: 0 }),
      }
      const r = await runUn1tSync(db, HATCH, opts(() => client))
      expect(r.ok).toBe(true)
      const conn = connRow(tables)
      expect(conn.last_ok_at).toBeUndefined()
      expect(conn.token_expires_at).toBeUndefined()
      expect(r.counts.connection_update_skipped).toBe('superseded')
      expect(runRow(tables).status).toBe('ok')
    })

    it('a ROTATED token (same token_id, new secret) supersedes the old run', async () => {
      const { db, tables, log } = makeDb(baseSeed())
      const client = {
        async getSelf() {
          // Rotation keeps the token id; only the secret and its fingerprint change.
          const row = tables.channel_connections[0]
          row.access_token = 'un1t_rotated_token_value'
          row.config = { ...row.config, token_fingerprint: tokenFingerprint('un1t_rotated_token_value') }
          throw new Un1tAuthError('refused', 401)
        },
        async listAll() { throw new Error('not reached') },
        stats: () => ({ requests: 1, waitedMs: 0, retries: 0 }),
      }
      const r = await runUn1tSync(db, HATCH, opts(() => client))
      expect(r.reason).toBe('auth')
      expect(connRow(tables)).toMatchObject({ status: 'connected', access_token: 'un1t_rotated_token_value' })
      expect(connRow(tables).config.token_id).toBe('tok-1')
      expect(r.counts.connection_update_skipped).toBe('superseded')
      // The fingerprint is non-secret; the token is still never a filter value.
      expect(JSON.stringify(log.map((e) => e.filters))).not.toContain('un1t_secret_token_value')
    })

    it('a row without a fingerprint is matched by reading the token, never by filtering on it', async () => {
      const seed = baseSeed()
      seed.channel_connections[0].config = {}
      const { db, tables, log } = makeDb(seed)
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(connRow(tables)).toMatchObject({ status: 'connected', last_ok_at: NOW_ISO })
      const upd = log.find((e) => e.table === 'channel_connections' && e.op === 'update')
      expect(upd.filters).toEqual(expect.arrayContaining([['eq', 'id', 'cc-1']]))
      expect(JSON.stringify(log.map((e) => e.filters))).not.toContain('un1t_secret_token_value')
    })

    it('a row without a fingerprint whose token changed is superseded', async () => {
      const seed = baseSeed()
      seed.channel_connections[0].config = {}
      const { db, tables } = makeDb(seed)
      const client = {
        async getSelf() {
          const row = tables.channel_connections[0]
          row.access_token = 'un1t_new_token_value'
          throw new Un1tAuthError('refused', 401)
        },
        async listAll() { throw new Error('not reached') },
        stats: () => ({ requests: 1, waitedMs: 0, retries: 0 }),
      }
      const r = await runUn1tSync(db, HATCH, opts(() => client))
      expect(r.reason).toBe('auth')
      expect(connRow(tables).status).toBe('connected')
      expect(r.counts.connection_update_skipped).toBe('superseded')
    })
  })

  it("a failed channel_connections write never puts the token (in the error's details) in a log, the run row or the result", async () => {
    const leaky = {
      code: '23514',
      message: 'new row for relation "channel_connections" violates check constraint "channel_connections_status_check"',
      details: 'Failing row contains (cc-1, loc-hatch, un1t_online, un1t_secret_token_value, ...).',
      hint: 'token un1t_secret_token_value',
    }
    const { db, tables } = makeDb(baseSeed(), { failUpdate: ['channel_connections', 'un1t_sync_runs'], updateError: leaky })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.connection_update_error).toContain('violates check constraint')
    expect(logError).toHaveBeenCalled()
    const logged = JSON.stringify([logError.mock.calls, logWarn.mock.calls])
    expect(logged).not.toContain('un1t_secret_token_value')
    expect(logged).not.toContain('Failing row')
    expect(logged).toContain('23514')
    expect(JSON.stringify(tables.un1t_sync_runs)).not.toContain('un1t_secret_token_value')
    expect(JSON.stringify(r)).not.toContain('un1t_secret_token_value')
  })

  it('a failed mirror upsert reports only the message in first_error and last_error', async () => {
    const leaky = { code: '23505', message: 'duplicate key value', details: 'Key (x)=(secret-ish) already exists.', hint: 'h' }
    const { db, tables } = makeDb(baseSeed(), { failUpsert: ['un1t_products'] })
    // Swap the generic upsert error for a detailed one.
    const from = db.from
    db.from = (t) => {
      const b = from(t)
      if (t !== 'un1t_products') return b
      const then = b.then
      b.then = (res, rej) => then.call(b, (out) => res(out.error ? { data: null, error: leaky } : out), rej)
      return b
    }
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.reason).toBe('db')
    expect(runRow(tables).first_error).toContain('duplicate key value')
    expect(runRow(tables).first_error).not.toContain('secret-ish')
    expect(connRow(tables).last_error).not.toContain('secret-ish')
  })

  it('a resolver error with no un1t_user_id ends nothing this run (fail closed)', async () => {
    const lists = fixtureLists()
    lists['/users/clients'] = [...lists['/users/clients'], { email: 'noid@x.ie', first_name: 'No Id' }]
    const seed = baseSeed({
      contact_memberships: [
        { id: 'm-old', organization_id: ORG, location_id: HATCH, contact_id: 'c-old', source: 'un1t_online_api', plan_name: 'X', status: 'active', ended_at: null },
      ],
    })
    const { db, tables } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.contacts.failed).toBe(1)
    expect(tables.contact_memberships.find((m) => m.id === 'm-old').status).toBe('active')
    expect(r.counts.memberships).toMatchObject({ end_skipped: 'contacts_unresolved', would_end: 1, ended: 0 })
  })

  it("spares a failing client's contact named by contact_id even when its un1t_user_id is not set", async () => {
    // u1's email matches c-att (un1t_user_id NULL); attaching it fails. u2 is
    // linked to c-other and its subscription is cancelled.
    const seed = baseSeed({
      contacts: [
        { id: 'c-att', organization_id: ORG, location_id: STILLORGAN, email: 'one@x.ie', un1t_user_id: null, first_name: 'One', last_name: 'One', phone: '+353870000001' },
        { id: 'c-other', organization_id: ORG, location_id: HATCH, email: 'two@x.ie', un1t_user_id: 'u2', first_name: 'Two', last_name: 'Two', phone: '+353870000002' },
      ],
      contact_memberships: [
        { id: 'm-att', organization_id: ORG, location_id: HATCH, contact_id: 'c-att', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
        { id: 'm-other', organization_id: ORG, location_id: HATCH, contact_id: 'c-other', source: 'un1t_online_api', plan_name: 'Unlimited', status: 'active', ended_at: null },
      ],
    })
    const { db, tables } = makeDb(seed, { failUpdateIds: ['c-att'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.contact_errors).toEqual([expect.objectContaining({ un1t_user_id: 'u1', contact_id: 'c-att' })])
    expect(tables.contacts.find((c) => c.id === 'c-att').un1t_user_id).toBeNull()
    expect(tables.contact_memberships.find((m) => m.id === 'm-att')).toMatchObject({ status: 'active', ended_at: null })
    expect(tables.contact_memberships.find((m) => m.id === 'm-other').status).toBe('ended')
    expect(r.counts.memberships.end_skipped_unresolved).toBe(1)
  })

  it('never issues a delete anywhere in a run', async () => {
    const seed = baseSeed({
      contact_memberships: [
        { id: 'm-old', organization_id: ORG, location_id: HATCH, contact_id: 'c-old', source: 'un1t_online_api', plan_name: 'X', status: 'active', ended_at: null },
      ],
    })
    const { db, log } = makeDb(seed)
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    await runUn1tSync(db, HATCH, opts(factory))
    expect(log.some((e) => e.op === 'delete')).toBe(false)
  })

  describe('marketing-preference rows for contacts linked from another studio (UN1TDUAL.3)', () => {
    const stillorganContact = (extra = {}) => ({
      id: 'c-still', organization_id: ORG, location_id: STILLORGAN, email: 'one@x.ie', un1t_user_id: null,
      first_name: 'One', last_name: 'X', phone: '+353870000001', email_status: 'active', ...extra,
    })
    const prefRows = (tables, contactId) => (tables.contact_location_preferences || []).filter((r) => r.contact_id === contactId)

    it('creates a Hatch preference row + consent_log for a Stillorgan contact linked at Hatch', async () => {
      const { db, tables } = makeDb(baseSeed({ contacts: [stillorganContact()] }))
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.studio_preferences).toEqual({ created: 1 })
      const rows = prefRows(tables, 'c-still')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        location_id: HATCH, email_marketing: true, sms_marketing: true, whatsapp_marketing: true, source: 'un1t_online_sync',
      })
      const logged = (tables.consent_log || []).filter((l) => l.contact_id === 'c-still')
      expect(logged.map((l) => l.channel).sort()).toEqual(['email_marketing', 'sms_marketing', 'whatsapp_marketing'])
      for (const l of logged) expect(l).toMatchObject({ action: 'opt_in', source: 'un1t_online_sync', location_id: HATCH })
    })

    it('an ALREADY-linked Stillorgan contact (rule 1, every later run): created once, then 0', async () => {
      const { db, tables } = makeDb(baseSeed({ contacts: [stillorganContact({ un1t_user_id: 'u1' })] }))
      const first = await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists: fixtureLists() }).factory))
      expect(first.ok).toBe(true)
      expect(first.counts.studio_preferences).toEqual({ created: 1 })
      expect(prefRows(tables, 'c-still')).toHaveLength(1)
      expect(prefRows(tables, 'c-still')[0]).toMatchObject({ location_id: HATCH, source: 'un1t_online_sync' })
      // the contact stayed at Stillorgan and stayed linked
      expect(tables.contacts.find((c) => c.id === 'c-still')).toMatchObject({ location_id: STILLORGAN, un1t_user_id: 'u1' })
      const logged = (tables.consent_log || []).length

      const second = await runUn1tSync(db, HATCH, opts(makeClient({ self: SELF, lists: fixtureLists() }).factory))
      expect(second.ok).toBe(true)
      expect(second.counts.studio_preferences).toEqual({ created: 0 })
      expect(prefRows(tables, 'c-still')).toHaveLength(1)
      expect((tables.consent_log || []).length).toBe(logged)
    })

    it('never touches an existing Hatch row (an unsubscribed member stays unsubscribed)', async () => {
      const existing = {
        contact_id: 'c-still', location_id: HATCH, email_marketing: false, sms_marketing: false, whatsapp_marketing: false,
        source: 'preference_centre', unsubscribed_at: '2026-09-01T00:00:00.000Z',
      }
      const { db, tables, log } = makeDb(baseSeed({ contacts: [stillorganContact()], contact_location_preferences: [{ ...existing }] }))
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.studio_preferences).toEqual({ created: 0 })
      expect(prefRows(tables, 'c-still')).toEqual([existing])
      expect(tables.consent_log || []).toHaveLength(0)
      expect(log.some((e) => e.table === 'contact_location_preferences' && e.op !== 'select')).toBe(false)
    })

    it('does nothing for contacts already at Hatch', async () => {
      const { db, tables, log } = makeDb(baseSeed())
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(r.counts.studio_preferences).toEqual({ created: 0 })
      expect(tables.contact_location_preferences || []).toHaveLength(0)
      expect(log.some((e) => e.table === 'consent_log')).toBe(false)
    })

    it('a failure leaves the run ok and is recorded in counts', async () => {
      const { db, tables } = makeDb(baseSeed({ contacts: [stillorganContact()] }), { failUpsert: ['contact_location_preferences'] })
      const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
      const r = await runUn1tSync(db, HATCH, opts(factory))
      expect(r.ok).toBe(true)
      expect(connRow(tables).status).toBe('connected')
      expect(r.counts.studio_preferences).toEqual({
        created: 0,
        error: { code: null, message: 'contact_location_preferences upsert boom' },
      })
      expect(logError).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('marketing-preference'), expect.objectContaining({
        locationId: HATCH, count: 0, code: null, message: 'contact_location_preferences upsert boom',
      }))
    })
  })
})

// UN1THARD.1 / .2 — one run per studio, abandoned runs, and the history window.
describe('runUn1tSync — overlap guard and history window', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a second run while one is running returns in_progress having read and written nothing', async () => {
    const running = { id: 'run-live', location_id: HATCH, status: 'running', started_at: new Date(NOW.getTime() - 60_000).toISOString() }
    const { db, tables, log } = makeDb(baseSeed({ un1t_sync_runs: [running] }))
    const { factory, calls } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r).toEqual({ ok: false, reason: 'in_progress', counts: expect.any(Object), runId: null })
    expect(factory).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    // Only the abandoned-run sweep ran (it matched nothing: the live run is recent).
    expect(writes(log).map((e) => `${e.table}:${e.op}`)).toEqual(['un1t_sync_runs:update', 'un1t_sync_runs:insert'])
    expect(tables.un1t_sync_runs).toEqual([running])
    expect(connRow(tables).status).toBe('connected')
    expect(logInfo).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('already running'), { locationId: HATCH })
  })

  it("another studio's running sync does not block this one", async () => {
    const other = { id: 'run-other', location_id: STILLORGAN, status: 'running', started_at: NOW_ISO }
    const { db } = makeDb(baseSeed({ un1t_sync_runs: [other] }))
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
  })

  it('closes a run left running longer than STALE_RUN_MS as abandoned, then runs', async () => {
    const dead = { id: 'run-dead', location_id: HATCH, status: 'running', started_at: new Date(NOW.getTime() - STALE_RUN_MS - 1000).toISOString() }
    const { db, tables } = makeDb(baseSeed({ un1t_sync_runs: [dead] }))
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    const closed = tables.un1t_sync_runs.find((x) => x.id === 'run-dead')
    expect(closed).toMatchObject({ status: 'error', finished_at: NOW_ISO })
    expect(closed.first_error).toMatch(/^abandoned/)
    expect(runRow(tables)).toMatchObject({ status: 'ok' })
    expect(logWarn).toHaveBeenCalledWith('un1t-online-sync', 'closed abandoned sync runs', { locationId: HATCH, count: 1 })
  })

  it('records the oldest row pulled and that nothing held is missing from a full pull', async () => {
    const lists = fixtureLists()
    lists['/bookings'] = [
      { id: 'b1', user_id: 'u1', event_id: 'e1', studio_id: STUDIO, created_at: '2026-09-28T10:00:00Z' },
      { id: 'b2', user_id: 'u2', event_id: 'e1', studio_id: STUDIO, created_at: '2026-09-27T18:35:40Z' },
    ]
    const { db } = makeDb(baseSeed())
    const { factory } = makeClient({ self: SELF, lists })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.history).toEqual({
      un1t_bookings: { absent_from_pull: 0, oldest_pulled: '2026-09-27T18:35:40Z' },
      un1t_events: { absent_from_pull: 0, oldest_pulled: '2026-10-20T17:30:00Z' },
    })
    expect(logInfo).not.toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('did not return'), expect.anything())
  })

  it('counts held rows the pull did not return (a rolling window) and says so', async () => {
    const heldOld = {
      id: 'held-1', location_id: HATCH, un1t_id: 'b-old', status: 'attended',
      remote_created_at: '2026-09-01T09:00:00Z', synced_at: '2026-10-01T00:00:00.000Z',
    }
    const elsewhere = { ...heldOld, id: 'held-2', location_id: STILLORGAN, un1t_id: 'b-x' }
    const { db } = makeDb(baseSeed({ un1t_bookings: [heldOld, elsewhere] }))
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(r.counts.history.un1t_bookings.absent_from_pull).toBe(1) // only this studio's
    expect(r.counts.history.un1t_events.absent_from_pull).toBe(0)
    expect(logInfo).toHaveBeenCalledWith('un1t-online-sync', expect.stringContaining('did not return'),
      expect.objectContaining({ locationId: HATCH }))
  })

  it('a failed history count is recorded and never fails the run', async () => {
    const { db, tables } = makeDb(baseSeed(), { failSelect: ['un1t_events'] })
    const { factory } = makeClient({ self: SELF, lists: fixtureLists() })
    const r = await runUn1tSync(db, HATCH, opts(factory))
    expect(r.ok).toBe(true)
    expect(connRow(tables).status).toBe('connected')
    expect(r.counts.history.un1t_events).toEqual({ absent_from_pull: null, oldest_pulled: '2026-10-20T17:30:00Z', error: 'un1t_events read boom' })
  })
})
