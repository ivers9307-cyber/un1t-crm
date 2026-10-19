// Test fakes for the un1t.online write primitives and the mirror write
// (UN1TWRITE.6). Never the live API, never a database. Fictional ids only.
import { vi } from 'vitest'

export const LOC = 'loc-test-1'
export const ORG = 'org-test-1'
export const STUDIO = 'studio-test-1'
export const TOKEN = 'secret-token-' + 'q'.repeat(51)
export const EVENT = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'
export const BOOKING = '33333333-3333-4333-8333-333333333333'
export const PRODUCT = '44444444-4444-4444-8444-444444444444'
export const NEW_USER = '55555555-5555-4555-8555-555555555555'
export const CONTACT = '66666666-6666-4666-8666-666666666666'
export const OTHER_CONTACT = '77777777-7777-4777-8777-777777777777'
export const ALL_PERMS = [
  'bookings:create', 'bookings:read', 'bookings:update', 'users:create', 'users:read',
  'purchases:create', 'products:read', 'credits:read',
]
export const ALLOWED_LOG_FIELDS = new Set(['locationId', 'op', 'origin', 'ledgerId', 'status', 'verdict', 'code', 'recovered', 'attempt', 'waitMs'])

/**
 * A response. `body` may be a function of the request ({ body }) so a fake
 * can echo what was sent (an error that quotes the password, say).
 */
export const res = (status, body, headers = {}) => (req) => {
  const b = typeof body === 'function' ? body(req) : body
  return new Response(b === undefined ? null : typeof b === 'string' ? b : JSON.stringify(b), { status, headers })
}
export const selfRes = (perms = ALL_PERMS, studio = STUDIO) =>
  res(200, { success: true, data: { id: 'tok-1', studio: { id: studio, name: 'Test' }, permissions: perms } })
export const ok = (data, extra = {}) => res(200, { success: true, data, ...extra })
export const created = (data) => res(201, { success: true, data })
export const page = (rows) => res(200, { success: true, pagination: { total: rows.length, page: 1, pages: 1, pageSize: 100 }, data: rows })

/** Route queues keyed 'METHOD /path' (no query). The last item repeats. */
export function makeFetch(routes) {
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]))
  const calls = []
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method || 'GET'
    const key = `${method} ${u.pathname}`
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ key, method, url, headers: init.headers || {}, body })
    const q = queues[key]
    if (!q || q.length === 0) throw new Error(`test: unexpected request ${key}`)
    const next = q.length > 1 ? q.shift() : q[0]
    return next({ body, headers: init.headers || {} })
  })
  fetchImpl.calls = calls
  fetchImpl.writes = () => calls.filter((c) => c.method !== 'GET')
  fetchImpl.count = (key) => calls.filter((c) => c.key === key).length
  return fetchImpl
}

export const CONN_ROW = (token = TOKEN, studio = STUDIO) => ({
  id: 'cc-1', location_id: LOC, platform: 'un1t_online', status: 'connected', is_active: true,
  label: null, display_name: null, external_account_id: studio, access_token: token, app_secret: null,
  config: { token_fingerprint: 'stored' }, token_expires_at: null, last_error: null, last_ok_at: null,
})

const clone = (v) => JSON.parse(JSON.stringify(v))

/**
 * A Supabase fake for the write side: locations, channel_connections, the
 * rate_limit_hit RPC, un1t_write_events (with the one-open index), contacts
 * (with the org un1t_user_id unique index), un1t_clients (unique per
 * location + user), un1t_bookings, un1t_products, plus any other table as a
 * plain row store.
 *
 * `fail` maps 'table.op' (op: select | insert | update | upsert) to the
 * error the call returns. `locationError` fails the settings read.
 * `membershipSource` is the studio's locations.membership_source.
 */
export function makeDb({
  settings = { un1t_online: { writes_enabled: true } },
  membershipSource = 'un1t_online',
  conn = CONN_ROW(),
  connError = null,
  locationError = null,
  rate = () => 1,
  tables = {},
  fail = {},
  hideOpenRows = false,
} = {}) {
  const store = {
    un1t_write_events: [], un1t_bookings: [], un1t_clients: [], contacts: [], un1t_products: [],
    ...clone(tables),
  }
  const calls = []
  const rpcCalls = []
  let seq = 0

  function from(name) {
    const s = { op: 'select', payload: null, opts: null, filters: [], order: null, limit: null, range: null }
    const matches = (r) => s.filters.every(([kind, c, v]) => {
      if (kind === 'eq') return r[c] === v
      if (kind === 'in') return v.includes(r[c])
      if (kind === 'is') return v === null ? r[c] === null || r[c] === undefined : r[c] === v
      if (kind === 'neq') return r[c] !== v
      if (kind === 'notnull') return r[c] !== null && r[c] !== undefined
      // A LIKE pattern as Postgres reads it (escaped _ % \\ are literal), case-insensitive.
      if (kind === 'ilike') {
        const re = new RegExp(`^${String(v).replace(/\\([_%\\])|([_%])|([.*+?^${'$'}{}()|[\]])/g, (m, esc, wild, meta) => (esc ? `\\${esc}` : wild === '_' ? '.' : wild === '%' ? '.*' : `\\${meta}`))}$`, 'i')
        return typeof r[c] === 'string' && re.test(r[c])
      }
      return false
    })
    const open = (r) => r.stage === 'sent' || r.stage === 'unknown'
    const dup = () => ({ data: null, error: { code: '23505', message: 'duplicate key', details: 'Key (k)=(v) already exists.' } })

    function run() {
      calls.push({ table: name, op: s.op, payload: s.payload ? clone(s.payload) : null, opts: s.opts, filters: s.filters.map((f) => [...f]) })
      const failure = fail[`${name}.${s.op}`]
      if (failure) return { data: null, error: failure }
      if (name === 'locations') {
        if (locationError) return { data: null, error: locationError }
        return { data: [{ id: LOC, name: 'Test Studio', organization_id: ORG, membership_source: membershipSource, settings }], error: null }
      }
      if (name === 'channel_connections') {
        if (connError) return { data: null, error: connError }
        return { data: conn ? [conn] : [], error: null }
      }
      const rows = (store[name] ??= [])
      if (s.op === 'insert') {
        const p = s.payload
        if (name === 'un1t_write_events' && rows.some((r) => open(r) && r.idempotency_key === p.idempotency_key)) return dup()
        if (name === 'un1t_clients' && rows.some((r) => r.location_id === p.location_id && r.un1t_user_id === p.un1t_user_id)) return dup()
        const row = { id: `${name}-${++seq}`, created_at: new Date().toISOString(), ...(name === 'un1t_write_events' ? { finished_at: null } : {}), ...p }
        rows.push(row)
        return { data: [{ ...row }], error: null }
      }
      if (s.op === 'upsert') {
        const keys = String(s.opts?.onConflict || 'id').split(',')
        const out = []
        for (const p of Array.isArray(s.payload) ? s.payload : [s.payload]) {
          const hit = rows.find((r) => keys.every((k) => r[k] === p[k]))
          if (hit) {
            if (!s.opts?.ignoreDuplicates) Object.assign(hit, p)
            out.push({ ...hit })
          } else {
            const row = { id: `${name}-${++seq}`, ...p }
            rows.push(row)
            out.push({ ...row })
          }
        }
        return { data: out, error: null }
      }
      if (s.op === 'update') {
        const hit = rows.filter(matches)
        if (name === 'contacts' && s.payload.un1t_user_id != null) {
          const taken = rows.some((r) => !hit.includes(r) && r.organization_id === (hit[0]?.organization_id ?? ORG) && r.un1t_user_id === s.payload.un1t_user_id)
          if (taken && hit.length) return dup()
        }
        for (const r of hit) Object.assign(r, s.payload)
        return { data: hit.map((r) => ({ ...r })), error: null }
      }
      let out = (name === 'un1t_write_events' && hideOpenRows ? rows.filter((r) => !open(r)) : rows).filter(matches).map((r) => ({ ...r }))
      if (s.order) {
        const [c, { ascending = true } = {}] = s.order
        out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1))
      }
      if (s.range) out = out.slice(s.range[0], s.range[1] + 1)
      if (s.limit != null) out = out.slice(0, s.limit)
      return { data: out, error: null }
    }

    const first = (r) => (r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null })
    const api = {
      select() { return api },
      insert(p) { s.op = 'insert'; s.payload = p; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      upsert(p, opts) { s.op = 'upsert'; s.payload = p; s.opts = opts ?? null; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      is(c, v) { s.filters.push(['is', c, v]); return api },
      neq(c, v) { s.filters.push(['neq', c, v]); return api },
      not(c, op, v) { if (op === 'is' && v === null) s.filters.push(['notnull', c]); return api },
      ilike(c, v) { s.filters.push(['ilike', c, v]); return api },
      order(c, o) { s.order = [c, o]; return api },
      limit(n) { s.limit = n; return api },
      range(a, b) { s.range = [a, b]; return api },
      single() { return Promise.resolve(first(run())) },
      maybeSingle() { return Promise.resolve(first(run())) },
      then(okFn, noFn) { return Promise.resolve(run()).then(okFn, noFn) },
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
  return { db, store, calls, rpcCalls }
}
