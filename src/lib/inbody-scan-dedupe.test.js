// INBODYDEDUPE.1 — the same InBody scan is recorded once, whichever road it
// takes into the CRM and however often it arrives.
//
// Runs the REAL routes and the REAL ingestScan against one in-memory database
// that enforces what mig 871 and mig 284 enforce in Postgres:
//   inbody_scans            UNIQUE (source, external_id)               (mig 272)
//                           UNIQUE (location_id, matched_phone9, scanned_at)
//                           matched_phone9 = last nine digits, generated (mig 871)
//   inbody_webhook_events   UNIQUE (account, user_id, test_datetime)   (mig 284)
// An insert that breaks either unique key on inbody_scans fails with 23505,
// exactly as Postgres would, so a writer aiming at the wrong conflict target
// fails here rather than in production. The SQL itself is proven in
// tests/migration-871-inbody-scans-natural-key.test.js.
//
// Roads covered: the InBody webhook re-sending a notification, two
// notifications for one scan, the bridge ingest re-sending a batch, a backfill
// ("Sync InBody") landing a scan before or after the webhook road (with the
// CRM's +353 spelling of the phone), and two Sync clicks for one member.
// Fictional ids and phone numbers only: the repo is public.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))
vi.mock('@/lib/body-metrics', () => ({ applyWeightObservation: vi.fn().mockResolvedValue(true) }))

import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { POST as webhookPOST } from '@/app/api/webhooks/inbody/route'
import { GET as pendingGET } from '@/app/api/bridge/inbody/pending/route'
import { POST as ingestPOST } from '@/app/api/bridge/inbody/ingest/route'
import { POST as backfillIngestPOST } from '@/app/api/bridge/inbody/backfill-ingest/route'
import { ingestScan } from './inbody-ingest.js'

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const ORG = '0e000000-0000-0000-0000-000000000001'
const CONTACT = 'c0000000-0000-0000-0000-000000000001'
const SECRET = 'test-inbody-secret'

// ─── In-memory database ──────────────────────────────────────────────────────

const phone9Generated = (phone) => {
  const d = String(phone ?? '').replace(/[^0-9]/g, '')
  return d.length >= 9 ? d.slice(-9) : null
}
const UNIQUE = {
  inbody_scans: [['source', 'external_id'], ['location_id', 'matched_phone9', 'scanned_at']],
  inbody_webhook_events: [['account', 'user_id', 'test_datetime']],
}
const GENERATED = { inbody_scans: (row) => ({ ...row, matched_phone9: phone9Generated(row.matched_phone) }) }
// NULL never equals anything, as in a unique index.
const sameKey = (a, b, cols) => cols.every((c) => a[c] != null && b[c] != null && a[c] === b[c])

function makeDb(seed) {
  const tables = { inbody_scans: [], inbody_webhook_events: [], inbody_backfill_requests: [], ...seed }
  let n = 0
  const nextId = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`

  function violates(table, row, except) {
    return (UNIQUE[table] || []).some((cols) => tables[table].some((r) => r !== except && sameKey(r, row, cols)))
  }

  function run(q) {
    const rows = tables[q.table] || (tables[q.table] = [])
    const match = (r) => q.filters.every((f) => f(r))
    if (q.op === 'select') {
      let out = rows.filter(match)
      if (q.limit != null) out = out.slice(0, q.limit)
      return { data: out.map((r) => ({ ...r })), error: null }
    }
    if (q.op === 'update') {
      for (const r of rows.filter(match)) Object.assign(r, q.payload)
      return { data: null, error: null }
    }
    // insert / upsert
    const gen = GENERATED[q.table] || ((r) => r)
    const inserted = []
    for (const input of [].concat(q.payload)) {
      const row = gen({ ...input })
      if (q.op === 'upsert') {
        const cols = String(q.opts?.onConflict || 'id').split(',').map((s) => s.trim())
        const known = (UNIQUE[q.table] || []).some((u) => u.join(',') === cols.join(','))
        if (!known) return { data: null, error: { code: '42P10', message: `no unique index on (${cols})` } }
        const hit = rows.find((r) => sameKey(r, row, cols))
        if (hit) {
          if (q.opts?.ignoreDuplicates) continue
          const merged = gen({ ...hit, ...input })
          if (violates(q.table, merged, hit)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
          Object.assign(hit, merged)
          inserted.push(hit)
          continue
        }
      }
      if (violates(q.table, row, null)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
      const full = { id: nextId(), ...row }
      rows.push(full)
      inserted.push(full)
    }
    return { data: inserted.map((r) => ({ ...r })), error: null }
  }

  function from(table) {
    const q = { table, op: 'select', filters: [], limit: null }
    const b = {
      select: () => b,
      eq: (c, v) => { q.filters.push((r) => r[c] != null && r[c] === v); return b },
      in: (c, vs) => { q.filters.push((r) => vs.includes(r[c])); return b },
      not: (c, _op, _v) => { q.filters.push((r) => r[c] != null); return b },
      or: () => b, // contacts phone pre-filter; matchContactId re-checks every row
      order: () => b,
      limit: (k) => { q.limit = k; return b },
      update: (p) => { q.op = 'update'; q.payload = p; return b },
      upsert: (p, o) => { q.op = 'upsert'; q.payload = p; q.opts = o; return b },
      insert: (p) => { q.op = 'insert'; q.payload = p; return b },
      maybeSingle: async () => {
        const r = run(q)
        return { data: r.data?.[0] ?? null, error: r.error }
      },
      single: async () => {
        const r = run(q)
        return r.data?.length === 1 ? { data: r.data[0], error: null } : { data: null, error: r.error || { code: 'PGRST116' } }
      },
      then: (resolve, reject) => Promise.resolve(run(q)).then(resolve, reject),
    }
    return b
  }

  return { from, tables }
}

// ─── Road helpers ────────────────────────────────────────────────────────────

const RAW = { Weight: 81.2, PercentBodyFat: 17.9, SkeletalMuscleMass: 37.5, BMI: 24.8 }

function notification({ tel = '0851234567', dt = '20261120093015', userId = '77', account = 'StillorganTest' } = {}) {
  return {
    EquipSerial: 'CC00000001', TelHP: tel, UserID: userId, TestDatetimes: dt,
    Account: account, Equip: 'InBody770', Type: 'InBody', IsTempData: 'false',
  }
}

// InBody → POST /api/webhooks/inbody.
async function webhook(body) {
  const raw = JSON.stringify(body)
  const res = await webhookPOST({ text: async () => raw, headers: { get: (h) => (h === 'x-inbody-secret' ? SECRET : null) } })
  return res.json()
}

const bridgeReq = (body) => ({ headers: { get: () => 'Bearer bbr_test' }, json: async () => body })

// The Pi's enrich cycle: GET pending, fetch each scan's data, POST ingest.
async function bridgeCycle() {
  const pending = await (await pendingGET(bridgeReq())).json()
  const results = pending.pending.map((p) => ({ event_id: p.event_id, raw: RAW }))
  if (results.length === 0) return { processed: 0, duplicates: 0, pending: 0 }
  return (await ingestPOST(bridgeReq({ results }))).json()
}

// "Sync InBody" on the contact queues a request (the inbody-sync route's
// insert); the Pi relays the member's history to backfill-ingest.
function queueSync(db, phone = '+353851234567') {
  const row = { id: `r0000000-0000-0000-0000-00000000000${db.tables.inbody_backfill_requests.length + 1}`, contact_id: CONTACT, phone, location_id: LOC_A, status: 'pending' }
  db.tables.inbody_backfill_requests.push(row)
  return row.id
}
async function backfill(requestId, { usertoken, datetimes = ['20261120093015'] } = {}) {
  const body = { request_id: requestId, scans: datetimes.map((d) => ({ datetimes: d, raw: RAW })) }
  if (usertoken !== undefined) body.usertoken = usertoken
  return (await backfillIngestPOST(bridgeReq(body))).json()
}

const scans = (db) => db.tables.inbody_scans
const events = (db) => db.tables.inbody_webhook_events

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.INBODY_WEBHOOK_SECRET = SECRET
  db = makeDb({
    locations: [
      { id: LOC_A, organization_id: ORG, settings: { inbody: { accounts: ['stillorgantest'] } } },
      { id: LOC_B, organization_id: ORG, settings: { inbody: { accounts: ['hatchtest'] } } },
    ],
    contacts: [{ id: CONTACT, organization_id: ORG, phone: '+353851234567', wa_phone: null }],
  })
  createServerClient.mockReturnValue(db)
  verifyBridgeToken.mockResolvedValue({ bridgeId: 'br-a', locationId: LOC_A })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('INBODYDEDUPE.1 — one scan, one row', () => {
  it('webhook retry: InBody re-sends the notification, one event, one scan', async () => {
    expect(await webhook(notification())).toEqual({ success: true })
    expect(await webhook(notification())).toEqual({ success: true })
    expect(events(db)).toHaveLength(1)
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 1, duplicates: 0 })
    expect(scans(db)).toHaveLength(1)
    expect(scans(db)[0]).toMatchObject({ location_id: LOC_A, contact_id: CONTACT, matched_phone9: '851234567' })
  })

  it('two notifications for one scan (no UserID, so capture cannot dedupe): one scan, both events handled', async () => {
    await webhook(notification({ userId: null }))
    await webhook(notification({ userId: null }))
    expect(events(db)).toHaveLength(2) // NULL user_id never collides on mig 284's index
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 2, duplicates: 1 })
    expect(scans(db)).toHaveLength(1)
    expect(events(db).every((e) => e.processed)).toBe(true)
    // Nothing left for the Pi to fetch again.
    expect((await (await pendingGET(bridgeReq())).json()).pending).toHaveLength(0)
  })

  it('bridge re-sends an ingest batch: still one scan', async () => {
    await webhook(notification())
    const [ev] = events(db)
    await ingestPOST(bridgeReq({ results: [{ event_id: ev.id, raw: RAW }] }))
    const again = await (await ingestPOST(bridgeReq({ results: [{ event_id: ev.id, raw: RAW }] }))).json()
    expect(again).toMatchObject({ processed: 0 }) // already processed: skipped
    expect(scans(db)).toHaveLength(1)
  })

  it('bridge then webhook: a later notification for a scan already on record is handled as a duplicate', async () => {
    await webhook(notification({ userId: '77' }))
    await bridgeCycle()
    // InBody notifies the same scan again under a different UserID: a new event.
    await webhook(notification({ userId: '78' }))
    expect(events(db)).toHaveLength(2)
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 1, duplicates: 1 })
    expect(scans(db)).toHaveLength(1)
    const second = events(db).find((e) => e.user_id === '78')
    expect(second).toMatchObject({ processed: true, matched_contact_id: CONTACT, location_id: LOC_A })
  })

  it('backfill (CRM +353 phone, old Pi sends no usertoken) then webhook (InBody 08… phone): one scan', async () => {
    const req = queueSync(db, '+353851234567')
    const b = await backfill(req) // no usertoken → route falls back to the CRM phone
    expect(b).toMatchObject({ ok: true, found: 1, ingested: 1, duplicates: 0 })
    expect(scans(db)[0].matched_phone).toBe('+353851234567')

    await webhook(notification({ tel: '0851234567' }))
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 1, duplicates: 1 })
    expect(scans(db)).toHaveLength(1)
    expect(events(db)[0].processed).toBe(true)
  })

  it('webhook then backfill with the Pi\'s bare-digits usertoken: one scan', async () => {
    await webhook(notification({ tel: '0851234567' }))
    await bridgeCycle()
    const b = await backfill(queueSync(db), { usertoken: '353851234567' })
    expect(b).toMatchObject({ ingested: 1, duplicates: 1 })
    expect(scans(db)).toHaveLength(1)
  })

  it('manual sync twice for one member: each scan once', async () => {
    const dts = ['20261101080000', '20261120093015']
    await backfill(queueSync(db), { usertoken: '0851234567', datetimes: dts })
    const second = await backfill(queueSync(db), { usertoken: '0851234567', datetimes: dts })
    expect(second).toMatchObject({ found: 2, ingested: 2, duplicates: 2 })
    expect(scans(db)).toHaveLength(2)
    expect(db.tables.inbody_backfill_requests.every((r) => r.status === 'done')).toBe(true)
  })

  it('a different scan for the same person records a second row', async () => {
    await webhook(notification({ dt: '20261120093015' }))
    await webhook(notification({ dt: '20261127093015' }))
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 2, duplicates: 0 })
    expect(scans(db)).toHaveLength(2)
    expect(scans(db).every((s) => s.contact_id === CONTACT)).toBe(true)
  })

  it('the same phone and second at another studio is another scan (the key carries the studio)', async () => {
    await ingestScan(db, { telHp: '0851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_A })
    const r = await ingestScan(db, { telHp: '+353851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_B })
    expect(r).toMatchObject({ ok: true, duplicate: false })
    expect(scans(db)).toHaveLength(2)
    expect(scans(db).map((s) => s.location_id).sort()).toEqual([LOC_A, LOC_B].sort())
  })

  it('another studio can no longer re-home a scan through the old phone_datetime key', async () => {
    await ingestScan(db, { telHp: '0851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_A })
    // Same spelling, same second, other studio: the old upsert on
    // (source, external_id) moved studio A's row to B. Now the write targets
    // the natural key, mig 272's unique external_id refuses it, and A's row
    // is untouched.
    const r = await ingestScan(db, { telHp: '0851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_B })
    expect(r).toMatchObject({ ok: false, reason: 'upsert_failed' })
    expect(scans(db)).toHaveLength(1)
    expect(scans(db)[0].location_id).toBe(LOC_A)
  })

  it('a re-delivery links a scan that first landed unlinked, without a second row', async () => {
    db.tables.contacts = []
    await ingestScan(db, { telHp: '0851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_A })
    expect(scans(db)[0].contact_id).toBeNull()
    db.tables.contacts = [{ id: CONTACT, organization_id: ORG, phone: '+353851234567', wa_phone: null }]
    const r = await ingestScan(db, { telHp: '0851234567', testDatetime: '20261120093015', raw: RAW, locationId: LOC_A })
    expect(r).toMatchObject({ ok: true, duplicate: true, linked: true, contactId: CONTACT })
    expect(scans(db)).toHaveLength(1)
    expect(scans(db)[0].contact_id).toBe(CONTACT)
  })

  it('a failed scan write leaves the event pending for a retry (never marked processed with nothing recorded)', async () => {
    await webhook(notification())
    const realFrom = db.from
    db.from = (t) => {
      const b = realFrom(t)
      if (t === 'inbody_scans') b.upsert = () => ({ then: (res) => Promise.resolve({ error: { message: 'boom' } }).then(res) })
      return b
    }
    const r = await bridgeCycle()
    expect(r).toMatchObject({ processed: 0 })
    expect(events(db)[0].processed).toBe(false)
    expect(scans(db)).toHaveLength(0)
  })
})
