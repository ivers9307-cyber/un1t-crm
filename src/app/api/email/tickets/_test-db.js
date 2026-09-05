// Test double for the service-role client, shared by the ticket route tests.
// (The legacy /api/email/conversations tests next door no longer need it —
// EMAIL-CONV-STOP.1 retired those routes to 410 Gone, and their tests now
// assert that no client is ever created.)
//
// It honours eq / in / is / not / or / ilike / order / limit rather than
// no-opping them, because the property under test IS a filter: "a coach
// granted studio@ must not see accounts@ tickets" is only proven if the
// route's own .in('mailbox_id', …) actually excludes rows. A permissive fake
// would pass those tests with the gate deleted.
//
// `ilike` was the exception until ILIKE-WILDCARD.1 — it fell through to
// `default: true`, so the compose route's contact lookup returned every
// contact regardless of the pattern. Exactly the hole this header warns
// about, in the one filter nobody had written a case for.
//
// Writes are recorded AND applied to the in-memory rows, so a test can assert
// both "the route wrote this" and "the row now looks like this".
//
// `state.errors` injects a PostgREST failure per table:
//   makeDb({ ...base, errors: { email_inbox_messages: { code: '42703', … } } })
// Every operation on that table then returns `{ data: null, error }`, which is
// exactly what a dropped column looks like from the client. Without it there
// is no way to test that a route inspects `.error` at all — a route that
// ignores it and one that handles it are indistinguishable against a fake that
// can only succeed (EMAIL-TICKET.6).

import { ilikeMatches } from '@/lib/like-escape.test-helpers'

function splitTopLevel(expr) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

// Minimal PostgREST `or=` evaluator — enough for `col.in.(a,b)`, `col.is.null`
// and `col.eq.v`, which is all this surface generates.
function orMatches(row, expr) {
  return splitTopLevel(expr).some(part => {
    const m = part.trim().match(/^([a-z_]+)\.(in|is|eq)\.(.*)$/)
    if (!m) return false
    const [, col, op, rawVal] = m
    const value = row[col] ?? null
    if (op === 'is') return rawVal === 'null' ? value === null : String(value) === rawVal
    if (op === 'eq') return String(value) === rawVal
    const list = rawVal.replace(/^\(/, '').replace(/\)$/, '')
      .split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    return list.includes(value)
  })
}

function matches(row, f) {
  const [kind, col, a, b] = f
  const value = row[col] ?? null
  switch (kind) {
    case 'eq': return value === a
    case 'in': return Array.isArray(a) && a.includes(value)
    case 'is': return a === null ? value === null : value === a
    case 'not': return a === 'is' && b === null ? value !== null : true
    case 'or': return orMatches(row, col)
    // Range filters — the prune path selects attachments older than a cutoff,
    // and a no-op here would let it prune rows it must not touch.
    case 'lt': return value !== null && value < a
    case 'lte': return value !== null && value <= a
    case 'gt': return value !== null && value > a
    case 'gte': return value !== null && value >= a
    // ilike used to fall through to `default: true` — a NO-OP, so the compose
    // route's contact lookup returned every contact whatever the pattern and
    // the fake could not tell an escaped query from an unescaped one. Model
    // the real thing (ILIKE-WILDCARD.1); see src/lib/like-escape.test-helpers.js.
    case 'neq': return value !== a
    case 'ilike': return ilikeMatches(a, value)
    default: return true
  }
}

const TABLE_KEYS = {
  email_mailboxes: 'mailboxes',
  email_mailbox_access: 'grants',
  email_tickets: 'tickets',
  email_inbox_messages: 'messages',
  email_sends: 'sends',
  contacts: 'contacts',
  // email_conversations is DELIBERATELY ABSENT (EMAIL-CONV-STOP.1): nothing may
  // read it any more, so a read falls through to []. Writes are still recorded
  // on db.inserts/db.updates before the key is consulted, which is what lets
  // `updatesTo(db, 'email_conversations')` prove a reintroduced write.
  locations: 'locations',
  // MAIL-SIG.2 — the studio half of the signature reads this per send.
  company_settings: 'companySettings',
  // EMAIL-MAILBOX-ADMIN.1 — the mailbox/grant editor lists the studio's staff,
  // so its tests need the roster the routes actually read.
  profile_locations: 'profileLocations',
  profiles: 'profiles',
  // EMAIL-ATTACH.1 — attachments and the per-mailbox storage counter.
  email_ticket_attachments: 'attachments',
  email_storage_usage: 'storageUsage',
  // audit_events is DELIBERATELY ABSENT, same reasoning as email_conversations:
  // logAuditEvent() builds its own client (which the tests point at this fake),
  // so its inserts land on db.inserts — assertable — without polluting a read.
}

// Unique indexes the fake enforces, as a 23505 on insert.
//
// THIS ONE IS LOAD-BEARING, NOT DECORATION. email_ticket_attachments'
// UNIQUE (message_id, attachment_index) is the entire reason storage
// accounting is idempotent across a re-processed inbound email (mig 496). A
// fake that let the second insert through would let a double-counting bug pass
// the very test written to catch it.
const UNIQUE_KEYS = {
  email_ticket_attachments: ['message_id', 'attachment_index'],
  email_storage_usage: ['location_id', 'mailbox_id'],
}

export function makeDb(state = {}) {
  const s = {
    mailboxes: [], grants: [], tickets: [], messages: [], sends: [], contacts: [],
    locations: [], profileLocations: [], profiles: [], companySettings: [],
    // EMAIL-ATTACH.1
    attachments: [], storageUsage: [], objects: new Map(), storageErrors: {},
    errors: {},
    ...state,
  }
  // `selects` records the COLUMN STRING each read asked for. The fake itself
  // returns whole rows regardless (modelling PostgREST's projection would buy
  // nothing), so this is the only way a test can assert what actually goes on
  // the wire — e.g. that a route stopped naming a column that is being dropped.
  // `ranges` records every .range() call per table so a test can prove a
  // fan-out paged rather than relying on the 1,000-row cap it cannot see.
  const db = { inserts: [], updates: [], deletes: [], selects: [], ranges: [], _state: s }
  let seq = 0

  function rowsFor(b) {
    const key = TABLE_KEYS[b._table]
    let rows = (key ? s[key] : []).filter(r => b._filters.every(f => matches(r, f)))
    if (b._order) {
      const { column, ascending } = b._order
      rows = [...rows].sort((x, y) => {
        const a = x[column] ?? ''
        const c = y[column] ?? ''
        if (a === c) return 0
        return (a < c ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    if (typeof b._limit === 'number') rows = rows.slice(0, b._limit)
    // MAIL-GDPR.1 / MAIL-SPAM.1 — .range(from, to) is inclusive on both ends,
    // like PostgREST, and MODELLED rather than stubbed for the same reason the
    // webhook fake models it: a fake that ignores paging cannot tell a paged
    // read from an unpaged one, so a paginating reader is exercised page by
    // page rather than handed everything on the first call. Applied AFTER
    // order, as Postgres would.
    if (b._range) rows = rows.slice(b._range[0], b._range[1] + 1)
    return rows
  }

  function settle(b, shape) {
    const key = TABLE_KEYS[b._table]
    // A failing table fails every operation on it, data null — the real shape
    // of a PostgREST error (a dropped column, a revoked grant, a bad cast).
    const injected = s.errors?.[b._table]
    if (injected) return { data: null, error: injected }
    if (b._op === 'insert') {
      db.inserts.push({ table: b._table, payload: b._payload })
      const unique = UNIQUE_KEYS[b._table]
      if (unique && key) {
        const clash = s[key].some(r => unique.every(col => (r[col] ?? null) === (b._payload[col] ?? null)))
        // The real 23505, shape and all — routes branch on `.code`.
        if (clash) {
          return {
            data: null,
            error: {
              code: '23505',
              message: `duplicate key value violates unique constraint on ${b._table}`,
            },
          }
        }
      }
      const row = { id: `new-${b._table}-${++seq}`, created_at: `2026-08-06T12:00:0${seq}Z`, ...b._payload }
      if (key) s[key].push(row)
      return { data: row, error: null }
    }
    if (b._op === 'update') {
      db.updates.push({ table: b._table, payload: b._payload, filters: b._filters })
      const hit = (key ? s[key] : []).filter(r => b._filters.every(f => matches(r, f)))
      for (const r of hit) Object.assign(r, b._payload)
      // PostgREST returns the changed ROWS; the single shape takes the first.
      // The list shape matters for the prune path, which decrements the counter
      // by exactly what its UPDATE actually changed — that is what stops two
      // concurrent prunes double-counting the same rows.
      //
      // EMAIL-ASSIGN.1 (review finding 4): a conditional UPDATE that matched
      // NOTHING under .single() is PGRST116 in real PostgREST — the shape the
      // claim/release race handling keys on. Returning null-data success here
      // made that branch dead code under this harness.
      if (shape === 'list') return { data: hit, error: null }
      return hit[0]
        ? { data: hit[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    }
    // EMAIL-MAILBOX-ADMIN.1 — revoking a mailbox grant DELETES the row, and
    // "the person can no longer see it" is only proven if the fake actually
    // removes it (a recorded-but-not-applied delete would let a broken revoke
    // pass). Rows are removed IN PLACE so an array captured before the call
    // still reflects the deletion, matching update's behaviour.
    if (b._op === 'delete') {
      db.deletes.push({ table: b._table, filters: b._filters })
      const rows = key ? s[key] : []
      const removed = rows.filter(r => b._filters.every(f => matches(r, f)))
      for (const r of removed) rows.splice(rows.indexOf(r), 1)
      return { data: removed, error: null }
    }
    db.selects.push({ table: b._table, columns: b._select ?? '*', options: b._selectOptions })
    const rows = rowsFor(b)

    // EMAIL-TICKET-CLEANUP.3 — count-only selects are MODELLED, not ignored.
    // `.select('*', { count: 'exact', head: true })` returns a number and NO
    // rows; a fake that dropped the options would have answered `{ data: rows }`
    // with `count` undefined, so the nav-badge route's `count || 0` would read
    // 0 for every input and every assertion about the badge — including "a
    // coach must not be counted accounts@ tickets" — would pass with the
    // mailbox scope deleted. Exactly the permissive-fake trap this file's
    // header warns about.
    const wantsCount = !!b._selectOptions?.count
    const headOnly = b._selectOptions?.head === true
    if (wantsCount) {
      // `count` is the number of rows MATCHING THE FILTERS, before .limit() —
      // which is what PostgREST returns and the whole reason a badge can be
      // cheap. rowsFor applies the limit, so count off the unlimited set.
      const total = rowsFor({ ...b, _limit: null }).length
      return { data: headOnly ? null : rows, count: total, error: null }
    }

    return shape === 'list' ? { data: rows, error: null } : { data: rows[0] ?? null, error: null }
  }

  db.from = (table) => {
    const b = { _table: table, _op: 'select', _payload: null, _filters: [], _order: null, _limit: null, _range: null }
    const filter = (kind) => (...args) => { b._filters.push([kind, ...args]); return b }
    // supabase-js reads head/count from the FIRST .select() after .from() only
    // (CLAUDE.md) — a .select() chained after a filter silently ignores them.
    // Modelled, so a route that chains them late fails here rather than in prod.
    b.select = (columns, options) => {
      b._select = columns ?? '*'
      if (b._selectOptions === undefined) b._selectOptions = options ?? null
      return b
    }
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.delete = () => { b._op = 'delete'; return b }
    b.eq = filter('eq')
    b.in = filter('in')
    b.is = filter('is')
    b.neq = filter('neq')
    b.not = filter('not')
    b.or = filter('or')
    b.ilike = filter('ilike')
    b.lt = filter('lt')
    b.lte = filter('lte')
    b.gt = filter('gt')
    b.gte = filter('gte')
    b.order = (column, opts = {}) => { b._order = { column, ascending: opts.ascending !== false }; return b }
    b.limit = (n) => { b._limit = n; return b }
    b.range = (from, to) => { b._range = [from, to]; db.ranges.push({ table, from, to }); return b }
    b.single = () => Promise.resolve(settle(b, 'single'))
    b.maybeSingle = () => Promise.resolve(settle(b, 'single'))
    // supabase-js builders are thenables, not Promises — mirror that exactly.
    b.then = (res, rej) => Promise.resolve(settle(b, 'list')).then(res, rej)
    return b
  }
  // ── RPCs ────────────────────────────────────────────────────────────
  // The two storage functions are MODELLED, not stubbed. `add_email_storage_bytes`
  // is what decides whether an attachment fits, and it returns the total AFTER
  // its own increment — a stub returning null would make every quota test pass
  // for the wrong reason, and the reserve-then-roll-back dance would be
  // untestable. Everything else still answers the old empty success.
  db.rpcs = []
  db.rpc = (fn, args = {}) => {
    db.rpcs.push({ fn, args })

    if (fn === 'add_email_storage_bytes') {
      if (s.errors?.add_email_storage_bytes) {
        return Promise.resolve({ data: null, error: s.errors.add_email_storage_bytes })
      }
      const locationId = args.p_location_id
      const mailboxId = args.p_mailbox_id ?? null
      let row = s.storageUsage.find(
        u => u.location_id === locationId && (u.mailbox_id ?? null) === mailboxId
      )
      if (!row) {
        row = {
          id: `new-usage-${++seq}`,
          location_id: locationId,
          mailbox_id: mailboxId,
          bytes_used: 0,
          quota_bytes: 5368709120,
        }
        s.storageUsage.push(row)
      }
      // greatest(…, 0) — the counter never goes negative, or freed space that
      // does not exist starts showing up as headroom.
      row.bytes_used = Math.max(0, row.bytes_used + (Number(args.p_delta) || 0))
      return Promise.resolve({ data: row.bytes_used, error: null })
    }

    if (fn === 'recalc_email_storage_usage') {
      const locationId = args.p_location_id
      const truth = new Map()
      for (const a of s.attachments) {
        if (a.location_id !== locationId || !a.storage_path) continue
        // EMAIL-FORWARD.1 (mig 501) — a row with forwarded_from_id set shares
        // the ORIGINAL'S object, so counting it would bill one file twice.
        // Modelled rather than ignored: without this line the fake would report
        // the double-count as correct and a recalc regression would pass.
        if (a.forwarded_from_id) continue
        const k = a.mailbox_id ?? null
        truth.set(k, (truth.get(k) || 0) + (Number(a.size_bytes) || 0))
      }
      for (const u of s.storageUsage) {
        if (u.location_id !== locationId) continue
        u.bytes_used = truth.get(u.mailbox_id ?? null) || 0
      }
      for (const [mailboxId, bytes] of truth) {
        const existing = s.storageUsage.find(
          u => u.location_id === locationId && (u.mailbox_id ?? null) === mailboxId
        )
        if (!existing) {
          s.storageUsage.push({
            id: `new-usage-${++seq}`,
            location_id: locationId,
            mailbox_id: mailboxId,
            bytes_used: bytes,
            quota_bytes: 5368709120,
          })
        }
      }
      return Promise.resolve({ data: null, error: null })
    }

    return Promise.resolve({ data: null, error: null })
  }

  // ── Storage ─────────────────────────────────────────────────────────
  // Objects are kept in a Map so a test can assert what actually landed in the
  // bucket — "the row says stored" and "the bytes are there" are different
  // claims, and the prune path is only correct if it settles both.
  db.storage = {
    from: (bucket) => ({
      upload: (path, bytes, opts) => {
        const err = s.storageErrors?.upload
        if (err) return Promise.resolve({ data: null, error: err })
        s.objects.set(`${bucket}/${path}`, { bytes, opts })
        return Promise.resolve({ data: { path }, error: null })
      },
      remove: (paths) => {
        const err = s.storageErrors?.remove
        if (err) return Promise.resolve({ data: null, error: err })
        for (const p of paths) s.objects.delete(`${bucket}/${p}`)
        return Promise.resolve({ data: paths.map(p => ({ name: p })), error: null })
      },
      // EMAIL-OUTBOUND-ATTACH.1 — the outbound path READS objects back (to
      // base64 them for Postmark) and MOVES them (draft key → canonical key).
      // Both are modelled against the same Map the upload path writes, so a
      // test can prove "the bytes that went on the wire are the bytes that were
      // uploaded" and "the object ended up at the key the row names".
      download: (path) => {
        const err = s.storageErrors?.download
        if (err) return Promise.resolve({ data: null, error: err })
        const object = s.objects.get(`${bucket}/${path}`)
        if (!object) return Promise.resolve({ data: null, error: { message: 'Object not found' } })
        const bytes = Buffer.isBuffer(object.bytes) ? object.bytes : Buffer.from(String(object.bytes))
        // supabase-js hands back a Blob; the reader accepts either, so the fake
        // returns the Blob-alike shape to keep that branch honest.
        return Promise.resolve({
          data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) },
          error: null,
        })
      },
      move: (from, to) => {
        const err = s.storageErrors?.move
        if (err) return Promise.resolve({ data: null, error: err })
        const object = s.objects.get(`${bucket}/${from}`)
        if (!object) return Promise.resolve({ data: null, error: { message: 'Object not found' } })
        s.objects.delete(`${bucket}/${from}`)
        s.objects.set(`${bucket}/${to}`, object)
        return Promise.resolve({ data: { message: 'Successfully moved' }, error: null })
      },
      createSignedUploadUrl: (path) => {
        const err = s.storageErrors?.signUpload
        if (err) return Promise.resolve({ data: null, error: err })
        return Promise.resolve({
          data: { path, token: `upload-token-for-${path}`, signedUrl: `https://storage.test/${bucket}/${path}?upload=1` },
          error: null,
        })
      },
      createSignedUrl: (path, ttl, opts) => {
        const err = s.storageErrors?.sign
        if (err) return Promise.resolve({ data: null, error: err })
        if (!s.objects.has(`${bucket}/${path}`) && !s.signAnything) {
          return Promise.resolve({ data: null, error: { message: 'Object not found' } })
        }
        const download = opts?.download ? `&download=${encodeURIComponent(opts.download)}` : ''
        return Promise.resolve({
          data: { signedUrl: `https://storage.test/${bucket}/${path}?token=signed&ttl=${ttl}${download}` },
          error: null,
        })
      },
    }),
  }

  return db
}

/** Every object currently in the fake bucket, as `bucket/path` keys. */
export const objectKeys = (db) => [...db._state.objects.keys()]

/**
 * Put bytes in the fake bucket without going through a route — how an outbound
 * test stands in for "the browser already uploaded this draft straight to
 * Storage", which is the whole point of the signed-upload hop.
 */
export const seedObject = (db, bucket, path, bytes) => {
  db._state.objects.set(`${bucket}/${path}`, {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)),
    opts: {},
  })
}

/** The counter for one bucket — `null` mailboxId is the unfiled bucket. */
export const usageFor = (db, locationId, mailboxId = null) =>
  db._state.storageUsage.find(
    u => u.location_id === locationId && (u.mailbox_id ?? null) === mailboxId
  ) || null

/**
 * Fail WRITES on `tables` while leaving reads untouched — the harness for the
 * sent-but-unfiled family (EMAIL-REPLY-UNFILED.1). `state.errors` cannot
 * express this: it fails every operation on the table, so a route that reads
 * before it sends would refuse up front and never reach the send; the case
 * under test only exists because the reads succeeded and a write then failed.
 * The failed write is NOT recorded on db.inserts/db.updates (settle never
 * runs), so per-table assertions see exactly what the real DB kept.
 *
 * `ops` narrows WHICH writes fail (default insert + update, the original
 * contract). MAIL-GDPR.1's attachment erasure runs an UPDATE (mark forwards)
 * and a DELETE (rows) on the same table and must survive either failing
 * alone, which neither the default nor `state.errors` can express.
 */
export function failWrites(db, tables, ops = ['insert', 'update']) {
  const realFrom = db.from
  db.from = (table) => {
    const b = realFrom(table)
    if (!tables.includes(table)) return b
    const failure = { data: null, error: { code: 'XX000', message: `${table} write exploded` } }
    for (const op of ops) {
      const orig = b[op]
      b[op] = (payload) => {
        orig(payload)
        b.single = () => Promise.resolve(failure)
        b.maybeSingle = () => Promise.resolve(failure)
        b.then = (res, rej) => Promise.resolve(failure).then(res, rej)
        return b
      }
    }
    return b
  }
}

export const insertsInto = (db, table) => db.inserts.filter(i => i.table === table)
export const updatesTo = (db, table) => db.updates.filter(u => u.table === table)
export const deletesFrom = (db, table) => db.deletes.filter(d => d.table === table)
export const selectsFrom = (db, table) => db.selects.filter(sel => sel.table === table)

/**
 * Every write this fake saw, whatever the table — the assertion a
 * "refused" test needs. `expect(writesTo(db)).toEqual([])` fails if a route
 * denied the caller but wrote anyway, which per-table helpers cannot show
 * (they only prove the tables you thought to name stayed clean).
 */
export const writesTo = (db) => [
  ...db.inserts.map(i => ({ op: 'insert', table: i.table })),
  ...db.updates.map(u => ({ op: 'update', table: u.table })),
  ...db.deletes.map(d => ({ op: 'delete', table: d.table })),
]
