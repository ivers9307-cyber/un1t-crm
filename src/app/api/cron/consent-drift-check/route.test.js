// CLASSPASS-CONSENT.2 — the drift check must report, and must NOT go green
// when it could not actually look. A check that stamps its heartbeat on a
// failed query is worse than no check: it reports health it never measured.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const stampHeartbeat = vi.fn()
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: (...a) => stampHeartbeat(...a) }))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase', () => ({ createServerClient: () => createServerClient() }))

vi.mock('@/lib/postmark-suppressions', () => ({
  suppressAtPostmark: vi.fn(async (emails) => ({ ok: (Array.isArray(emails) ? emails : [emails]).length, failed: [] })),
  unsuppressAtPostmark: vi.fn(async () => ({ ok: 0, failed: [], skipped: [] })),
  listPostmarkSuppressions: vi.fn(async () => ({ suppressions: [], error: null })),
}))

const { suppressAtPostmark, unsuppressAtPostmark, listPostmarkSuppressions } = await import('@/lib/postmark-suppressions')
const { GET, findConsentDrift, reconcilePostmarkSuppressions, PAGE_SIZE, MAX_SUPPRESSIONS_PER_RUN } = await import('./route.js')

const req = (auth) => ({ headers: { get: (k) => (k === 'authorization' ? auth : null) } })

// ── supabase double ─────────────────────────────────────────────────
// Chainable + thenable (supabase-js builders are thenables), honours
// .range() so the pagination loop is genuinely exercised, and records every
// statement so a test can prove the report-only direction wrote NOTHING.
//
// It replays `.in()` filters for real, because that is the filter that scopes
// the auto-heal to genuine decisions — a mock that ignored it would let the
// bulk_import test below pass against a broken query. `.eq()/.not()/.is()` are
// recorded but not replayed; the fixtures are already the shape those select.
//
// `consentLog` defaults to one voluntary opt-out per opted-out contact, so the
// tests that are about OTHER axes (pagination, the cap, push failures) do not
// each have to restate the taxonomy.
function makeDb({ rpcRows = [], optedOut = [], mailable = [], consentLog = null, failTable = null } = {}) {
  const statements = []
  const log = consentLog || optedOut.map((c, i) => ({
    id: `log-${i}`, contact_id: c.id, channel: 'email_marketing',
    action: 'opt_out', source: 'one_click_unsubscribe',
  }))
  const table = (name) => {
    const state = { table: name, op: 'select', filters: [], range: null }
    statements.push(state)
    const builder = {
      select: (cols) => { state.op = 'select'; state.columns = cols; return builder },
      insert: (rows) => { state.op = 'insert'; state.payload = rows; return builder },
      update: (patch) => { state.op = 'update'; state.payload = patch; return builder },
      eq: (...a) => { state.filters.push(['eq', ...a]); return builder },
      in: (...a) => { state.filters.push(['in', ...a]); return builder },
      not: (...a) => { state.filters.push(['not', ...a]); return builder },
      is: (...a) => { state.filters.push(['is', ...a]); return builder },
      order: (...a) => { state.filters.push(['order', ...a]); return builder },
      range: (from, to) => { state.range = [from, to]; return builder },
      then: (resolve, reject) => Promise.resolve(result(state)).then(resolve, reject),
    }
    return builder
  }
  const result = (state) => {
    if (state.table === failTable) return { data: null, error: { message: `${failTable} query failed` } }
    const source = state.table === 'contacts' ? optedOut
      : state.table === 'contact_location_audience' ? mailable
        : state.table === 'consent_log' ? log
          : []
    const rows = state.filters
      .filter(f => f[0] === 'in')
      .reduce((acc, [, col, values]) => acc.filter(r => values.includes(r[col])), source)
    const [from, to] = state.range || [0, rows.length - 1]
    return { data: rows.slice(from, to + 1), error: null }
  }
  return {
    from: vi.fn(table),
    rpc: vi.fn(async () => ({ data: rpcRows, error: null })),
    statements,
  }
}

const row = (email, extra = {}) => ({ id: `c-${email}`, email, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  listPostmarkSuppressions.mockResolvedValue({ suppressions: [], error: null })
  suppressAtPostmark.mockImplementation(async (emails) => ({ ok: (Array.isArray(emails) ? emails : [emails]).length, failed: [] }))
  process.env.CRON_SECRET = 'test-secret'
})
afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('findConsentDrift', () => {
  it('returns the drifted rows', async () => {
    const rows = [{ contact_id: 'a', location_id: 'loc-1', email: 'a@x.com' }]
    const db = { rpc: vi.fn(async () => ({ data: rows, error: null })) }
    expect(await findConsentDrift(db)).toEqual({ rows, error: null })
    expect(db.rpc).toHaveBeenCalledWith('consent_drift_rows')
  })

  it('reports the error instead of throwing when the query fails', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) }
    expect(await findConsentDrift(db)).toEqual({ rows: [], error: 'boom' })
  })

  it('treats a null data payload as no drift', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: null })) }
    expect(await findConsentDrift(db)).toEqual({ rows: [], error: null })
  })
})

describe('GET /api/cron/consent-drift-check', () => {
  it('401s without the CRON_SECRET bearer', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset, rather than matching "Bearer undefined"', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req('Bearer undefined'))
    expect(res.status).toBe(401)
  })

  it('stamps the heartbeat and reports zero drift on a clean run', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await GET(req('Bearer test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { drift: 0, contacts: [] } })
    expect(stampHeartbeat).toHaveBeenCalledWith('consent-drift-check')
  })

  it('reports the drifted contacts and still stamps the heartbeat', async () => {
    const rows = [
      { contact_id: 'a', location_id: 'loc-1', email: 'a@x.com' },
      { contact_id: 'b', location_id: 'loc-1', email: 'b@x.com' },
    ]
    createServerClient.mockReturnValue(makeDb({ rpcRows: rows }))
    const res = await GET(req('Bearer test-secret'))
    const body = await res.json()
    expect(body.data.drift).toBe(2)
    expect(body.data.contacts).toEqual(rows)
    expect(stampHeartbeat).toHaveBeenCalledWith('consent-drift-check')
  })

  it('does NOT stamp the heartbeat when the query failed', async () => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// PMSUPP.1 — the Postmark ↔ database reconciliation.
//
// THE TWO DIRECTIONS ARE TREATED DIFFERENTLY ON PURPOSE, and these tests are
// what hold that apart:
//   • we say opted out, Postmark is NOT suppressed → AUTO-HEAL. Pushing a
//     suppression only ever ADDS a refusal, so it is safe unattended.
//   • Postmark IS suppressed, we say mailable      → REPORT ONLY. Inferring a
//     consent change from a suppression and writing it unattended is exactly
//     the silent write that caused the mig 544 incident.
describe('reconcilePostmarkSuppressions', () => {
  it('pushes a suppression for someone we say is opted out and Postmark does not have', async () => {
    const db = makeDb({ optedOut: [row('gone@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(suppressAtPostmark).toHaveBeenCalledWith(['gone@x.com'], { stream: 'broadcast' })
    expect(out.error).toBeNull()
    expect(out.missingSuppression).toBe(1)
    expect(out.suppressed).toBe(1)
  })

  it('pushes only the opt-outs that were a PERSON’S DECISION, by the consent-source taxonomy', async () => {
    // Measured on prod: 5,177 addresses are opted out and unsuppressed, but
    // 3,963 are bulk_import and 1,533 auto_classpass_backfill — imported state
    // and ClassPass relay addresses, never subscribers who left. Only ~132 are
    // somebody's decision. Pushing the rest would turn Postmark's suppression
    // list into a 5,000-row mirror of our database and destroy its forensic
    // value. The set comes from src/lib/consent-sources.js, not a hand-rolled
    // list, so a new source is classified once.
    const db = makeDb({
      optedOut: [row('clicked@x.com'), row('sibling@x.com'), row('imported@x.com'), row('classpass@x.com'), row('bounced@x.com')],
      consentLog: [
        { id: 'l1', contact_id: 'c-clicked@x.com', channel: 'email_marketing', action: 'opt_out', source: 'one_click_unsubscribe' },
        { id: 'l2', contact_id: 'c-sibling@x.com', channel: 'email_marketing', action: 'opt_out', source: 'duplicate_propagation' },
        { id: 'l3', contact_id: 'c-imported@x.com', channel: 'email_marketing', action: 'opt_out', source: 'bulk_import' },
        { id: 'l4', contact_id: 'c-classpass@x.com', channel: 'email_marketing', action: 'opt_out', source: 'auto_classpass' },
        { id: 'l5', contact_id: 'c-bounced@x.com', channel: 'email_marketing', action: 'opt_out', source: 'postmark_hard_bounce' },
      ],
    })
    const out = await reconcilePostmarkSuppressions(db)
    // voluntary + the duplicate_propagation exception; bulk / policy /
    // deliverability all stay out.
    expect(suppressAtPostmark).toHaveBeenCalledWith(['clicked@x.com', 'sibling@x.com'], { stream: 'broadcast' })
    expect(out.missingSuppression).toBe(2)
  })

  it('pushes nothing for an opted-out contact with no consent_log evidence at all', async () => {
    const db = makeDb({ optedOut: [row('mystery@x.com')], consentLog: [] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(out.missingSuppression).toBe(0)
  })

  it('pushes NOTHING for someone Postmark already refuses', async () => {
    listPostmarkSuppressions.mockResolvedValue({
      suppressions: [{ EmailAddress: 'GONE@x.com', SuppressionReason: 'ManualSuppression' }],
      error: null,
    })
    const db = makeDb({ optedOut: [row('gone@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(out.missingSuppression).toBe(0)
  })

  it('pushes NOTHING for someone opted out globally but still mailable at a location', async () => {
    // The LEADCAP.1 shape — opted out at Stillorgan, opted IN to the Hatch
    // Street waitlist. consent_drift_rows() excludes it for the same reason: a
    // Postmark suppression is server-wide and would kill the mail they asked
    // for.
    const db = makeDb({ optedOut: [row('waitlist@x.com')], mailable: [row('Waitlist@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(out.missingSuppression).toBe(0)
  })

  it('REPORTS a Postmark suppression on someone we still consider mailable, and writes NOTHING', async () => {
    listPostmarkSuppressions.mockResolvedValue({
      suppressions: [{ EmailAddress: 'left@x.com', SuppressionReason: 'ManualSuppression', Origin: 'Recipient' }],
      error: null,
    })
    const db = makeDb({ mailable: [row('Left@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)

    expect(out.suppressedButMailable).toBe(1)
    expect(out.suppressedButMailableSample).toEqual([{ email: 'Left@x.com', reason: 'ManualSuppression' }])
    // The whole point: no consent write, no un-suppression, nothing.
    expect(db.statements.every(s => s.op === 'select')).toBe(true)
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(out.byReason).toEqual({ ManualSuppression: 1 })
  })

  it('paginates past the 1,000-row select cap', async () => {
    const many = Array.from({ length: PAGE_SIZE + 7 }, (_, i) => row(`u${i}@x.com`))
    const db = makeDb({ optedOut: many })
    const out = await reconcilePostmarkSuppressions(db)
    const contactReads = db.statements.filter(s => s.table === 'contacts')
    expect(contactReads.length).toBe(2)
    expect(contactReads[0].range).toEqual([0, PAGE_SIZE - 1])
    expect(contactReads[1].range).toEqual([PAGE_SIZE, PAGE_SIZE * 2 - 1])
    // Every page is ordered, or .range() would slice an unstable set.
    expect(contactReads[0].filters.some(f => f[0] === 'order')).toBe(true)
    expect(out.missingSuppression).toBe(PAGE_SIZE + 7)
  })

  it('caps how many suppressions one run pushes and reports the remainder', async () => {
    const many = Array.from({ length: MAX_SUPPRESSIONS_PER_RUN + 5 }, (_, i) => row(`u${i}@x.com`))
    const db = makeDb({ optedOut: many })
    const out = await reconcilePostmarkSuppressions(db)
    expect(suppressAtPostmark.mock.calls[0][0]).toHaveLength(MAX_SUPPRESSIONS_PER_RUN)
    expect(out.remaining).toBe(5)
  })

  it('reports a partial push failure without pretending it healed', async () => {
    suppressAtPostmark.mockResolvedValue({ ok: 1, failed: [{ email: 'b@x.com', message: 'HTTP 500' }] })
    const db = makeDb({ optedOut: [row('a@x.com'), row('b@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(out.suppressed).toBe(1)
    expect(out.suppressFailed).toBe(1)
  })

  it('errors instead of "healing" when Postmark cannot be read', async () => {
    listPostmarkSuppressions.mockResolvedValue({ suppressions: [], error: 'Bad token' })
    const db = makeDb({ optedOut: [row('gone@x.com')] })
    const out = await reconcilePostmarkSuppressions(db)
    expect(out.error).toContain('Bad token')
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('errors instead of "healing" when the database read fails', async () => {
    const db = makeDb({ optedOut: [row('gone@x.com')], failTable: 'contact_location_audience' })
    const out = await reconcilePostmarkSuppressions(db)
    expect(out.error).toContain('contact_location_audience')
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/consent-drift-check — Postmark reconciliation (PMSUPP.1)', () => {
  it('reports both directions in the response and stamps the heartbeat', async () => {
    listPostmarkSuppressions.mockResolvedValue({
      suppressions: [{ EmailAddress: 'left@x.com', SuppressionReason: 'ManualSuppression' }],
      error: null,
    })
    createServerClient.mockReturnValue(makeDb({ optedOut: [row('gone@x.com')], mailable: [row('left@x.com')] }))
    const res = await GET(req('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.postmark).toMatchObject({
      missingSuppression: 1,
      suppressed: 1,
      suppressedButMailable: 1,
    })
    expect(stampHeartbeat).toHaveBeenCalledWith('consent-drift-check')
  })

  it('does NOT stamp the heartbeat when the reconciliation could not run', async () => {
    listPostmarkSuppressions.mockResolvedValue({ suppressions: [], error: 'Postmark down' })
    createServerClient.mockReturnValue(makeDb())
    const res = await GET(req('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
