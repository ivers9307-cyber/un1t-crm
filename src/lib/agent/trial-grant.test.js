import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  fetchUserCreditsResult: vi.fn(),
  purchaseGlofoxMembership: vi.fn(),
}))
// computeCreditsRemaining's real rules are glofox-sync's own tests' business;
// here a list of { available } rows sums, and an empty list is null.
vi.mock('@/lib/glofox-sync', () => ({
  computeCreditsRemaining: vi.fn((rows) => (Array.isArray(rows) && rows.length ? rows.reduce((n, r) => n + (r.available || 0), 0) : null)),
}))
vi.mock('@/lib/connection-registry', () => ({ readGlofoxConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { grantTrialBeforeBooking, TRIAL_GRANT_FAILED, TRIAL_NOT_CONFIGURED, TRIAL_GRANT_UNVERIFIED, TRIAL_GRANT_UNRECORDED, TRIAL_PRODUCT_UNKNOWN, TRIAL_ALREADY_GRANTED, TRIAL_HISTORY_UNREADABLE } from './trial-grant'
import { fetchUserCreditsResult, purchaseGlofoxMembership } from '@/lib/glofox'
import { readGlofoxConfig } from '@/lib/connection-registry'
import { logError, logWarn } from '@/lib/log'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
// The route's write-ahead: persists details.trial_grant on THIS execution
// (a guarded update) and answers whether it landed.
const record = vi.fn()
const base = { creds, locationId: 'L1', memberId: 'gm1', requestId: 'amr-1', record, now: () => '2026-10-01T09:00:00.000Z' }

// A small PostgREST stand-in over in-memory tables: eq/neq/is on top-level
// columns, contains() as a jsonb partial match, limit(). A table given as
// { error } answers that error to every read. TRIALCLAIM.1: insert() and
// update() work on glofox_trial_claims, which enforces the mig 697 partial
// unique index (one live claim per location + member) with a 23505, and
// `faults` makes a write or a read of a table fail:
//   faults.insert[table] / faults.update[table] / faults.read[table] = error
function deepContains(value, pattern) {
  if (pattern && typeof pattern === 'object') {
    if (!value || typeof value !== 'object') return false
    return Object.entries(pattern).every(([k, v]) => deepContains(value[k], v))
  }
  return value === pattern
}
const UNIQUE_LIVE = { code: '23505', message: 'duplicate key value violates unique constraint "glofox_trial_claims_one_live"' }
function makeDb(tables = {}, faults = {}) {
  const reads = []
  const writes = []
  let seq = 0
  const rowsOf = (table) => {
    if (!Array.isArray(tables[table])) tables[table] = []
    return tables[table]
  }
  return {
    reads,
    writes,
    tables,
    from(table) {
      const filters = []
      let cap = Infinity
      let op = 'select'
      let payload = null
      const run = () => {
        if (op === 'insert') {
          writes.push({ table, op, row: payload })
          if (faults.insert?.[table]) return { data: null, error: faults.insert[table] }
          const rows = rowsOf(table)
          if (table === 'glofox_trial_claims' && rows.some((r) => r.released_at == null
            && r.location_id === payload.location_id && r.glofox_member_id === payload.glofox_member_id)) {
            return { data: null, error: UNIQUE_LIVE }
          }
          seq += 1
          const row = { id: `claim-${seq}`, released_at: null, release_reason: null, push_event_id: null, ...payload }
          rows.push(row)
          return { data: [{ id: row.id }], error: null }
        }
        if (op === 'update') {
          writes.push({ table, op, patch: payload })
          if (faults.update?.[table]) return { data: null, error: faults.update[table] }
          const hit = rowsOf(table).filter((r) => filters.every((f) => f(r)))
          for (const r of hit) Object.assign(r, payload)
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        reads.push(table)
        if (faults.read?.[table]) return { data: null, error: faults.read[table] }
        const t = tables[table]
        return t && !Array.isArray(t) && t.error
          ? { data: null, error: t.error }
          : { data: (t || []).filter((r) => filters.every((f) => f(r))).slice(0, cap), error: null }
      }
      const q = {
        select() { return q },
        insert(row) { op = 'insert'; payload = row; return q },
        update(patch) { op = 'update'; payload = patch; return q },
        eq(col, v) { filters.push((r) => r[col] === v); return q },
        neq(col, v) { filters.push((r) => r[col] !== v); return q },
        is(col, v) { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return q },
        contains(col, v) { filters.push((r) => deepContains(r[col], v)); return q },
        limit(n) { cap = n; return q },
        async single() {
          const out = run()
          if (out.error) return out
          return out.data?.length === 1 ? { data: out.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } }
        },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
      }
      return q
    },
  }
}
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
  readGlofoxConfig.mockResolvedValue({ cfg: { trial_membership_id: 'tm-1', trial_plan_code: 'tp-1' }, error: null })
  purchaseGlofoxMembership.mockResolvedValue({ ok: true, http_status: 200, message_code: 'CART_LEGACY_PURCHASE_SUCCESS', purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
  record.mockReset().mockResolvedValue(true)
})

describe('grantTrialBeforeBooking (TRIALGRANT.1)', () => {
  it('no credits, trial set, purchase granted → proceed, grant recorded with the invoice id', async () => {
    const out = await grantTrialBeforeBooking(db, base)

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-1', 'tp-1')
    expect(out).toEqual({ proceed: true, failure: null, grant: { ok: true, at: '2026-10-01T09:00:00.000Z', glofox_member_id: 'gm1', purchase_status: 'SUCCESS', invoice_id: 'inv-1' } })
  })

  it('purchase refused → proceed:false, TRIAL_GRANT_FAILED with Glofox’s own code, logged without PII', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 200, message_code: 'PURCHASE_NOT_ALLOWED', purchase_status: 'ERROR', error: 'Membership cannot be purchased' })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(false)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_FAILED, glofox_message_code: 'PURCHASE_NOT_ALLOWED', http_status: 200, purchase_status: 'ERROR' })
    expect(out.grant).toMatchObject({ ok: false, code: TRIAL_GRANT_FAILED, glofox_message_code: 'PURCHASE_NOT_ALLOWED' })
    expect(logError).toHaveBeenCalledWith('trial-grant', expect.any(String), { requestId: 'amr-1', code: TRIAL_GRANT_FAILED, glofoxCode: 'PURCHASE_NOT_ALLOWED', httpStatus: 200, purchaseStatus: 'ERROR' })
  })

  it('a grant an earlier attempt RECORDED is never bought again (no Glofox call at all)', async () => {
    const prior = { ok: true, at: '2026-09-30T18:00:00.000Z', invoice_id: 'inv-0' }

    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: prior, isRetry: true })

    expect(out).toEqual({ proceed: true, grant: prior, failure: null })
    expect(fetchUserCreditsResult).not.toHaveBeenCalled()
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('credits already on the account (added by hand, or an unrecorded grant) → proceed, nothing bought', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 3 }] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out).toEqual({ proceed: true, failure: null, grant: { ok: true, at: '2026-10-01T09:00:00.000Z', glofox_member_id: 'gm1', skipped: 'credits_present' } })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('unreadable credits on a FIRST approval still buys, as before (the card rests on a read that worked)', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: false, credits: [] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('unreadable credits on a RETRY → TRIAL_GRANT_UNVERIFIED, nothing bought (an earlier attempt may have granted)', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: false, credits: [] })

    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { ok: false, code: TRIAL_GRANT_FAILED }, isRetry: true })

    expect(out.proceed).toBe(false)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('trial settings unreadable → GLOFOX_SETTINGS_UNREADABLE, never "not configured", nothing bought', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: { message: 'boom' } })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.failure).toEqual({ ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('no trial product set → TRIAL_NOT_CONFIGURED, nothing bought', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: { trial_membership_id: 'tm-1' }, error: null })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_NOT_CONFIGURED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('never throws: an exception inside is a TRIAL_GRANT_FAILED', async () => {
    purchaseGlofoxMembership.mockRejectedValueOnce(new Error('kaboom'))

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(false)
    expect(out.failure).toMatchObject({ ok: false, message_code: TRIAL_GRANT_FAILED, error: 'exception' })
  })

  // A recorded SKIP bought nothing, so it is no reason not to buy later: the
  // credits it found may have been used or lapsed by the time of a retry.
  it('a recorded credits_present skip is re-checked on a retry, and buys when the credits are gone', async () => {
    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { ok: true, at: '2026-09-30T18:00:00.000Z', skipped: 'credits_present' }, isRetry: true })

    expect(fetchUserCreditsResult).toHaveBeenCalledTimes(1)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(out.proceed).toBe(true)
    expect(out.grant).toMatchObject({ ok: true, invoice_id: 'inv-1' })
  })

  it('an exception is logged WITH the error, not discarded', async () => {
    const boom = new Error('kaboom')
    purchaseGlofoxMembership.mockRejectedValueOnce(boom)

    await grantTrialBeforeBooking(db, base)

    expect(logError).toHaveBeenCalledWith('trial-grant', expect.any(String), expect.objectContaining({ requestId: 'amr-1', code: TRIAL_GRANT_FAILED, err: boom }))
  })

  // The /start funnel block can name its own trial (class_booking_requests
  // .trial_membership_id/trial_plan_code, which the mint path buys); the card
  // carries it, and the approve buys THAT, not the location default.
  it('a funnel trial override on the card wins over the location default (no settings read)', async () => {
    const out = await grantTrialBeforeBooking(db, { ...base, trialOverride: { membershipId: 'tm-funnel', planCode: 'tp-funnel' } })

    expect(readGlofoxConfig).not.toHaveBeenCalled()
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-funnel', 'tp-funnel')
    expect(out.proceed).toBe(true)
  })

  it('an override buys even where the location sets no default trial (was TRIAL_NOT_CONFIGURED)', async () => {
    readGlofoxConfig.mockResolvedValue({ cfg: {}, error: null })

    const out = await grantTrialBeforeBooking(db, { ...base, trialOverride: { membershipId: 'tm-funnel', planCode: 'tp-funnel' } })

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-funnel', 'tp-funnel')
  })

  it('a half override (one id only) is ignored: the location default is bought', async () => {
    await grantTrialBeforeBooking(db, { ...base, trialOverride: { membershipId: 'tm-funnel', planCode: null } })

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-1', 'tp-1')
  })
})

// Review should-fix: the grant used to reach the database only in the
// route's FINAL update. A purchase that went through, followed by a death
// before that write (createBooking stuck in Glofox backoff until the function
// timed out), left a stuck card with no record, and its retry could buy a
// second trial whenever the first one's credits did not show yet (a trial
// queued behind a membership the member already holds). Now the grant is
// written AHEAD: a 'purchasing' marker before the purchase, the outcome
// after it, both before any booking.
describe('grantTrialBeforeBooking: the write-ahead grant record', () => {
  it('records a purchasing marker BEFORE buying and the outcome AFTER', async () => {
    await grantTrialBeforeBooking(db, base)

    expect(record).toHaveBeenCalledTimes(2)
    expect(record.mock.calls[0][0]).toEqual({ stage: 'purchasing', at: '2026-10-01T09:00:00.000Z', glofox_member_id: 'gm1' })
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(purchaseGlofoxMembership.mock.invocationCallOrder[0])
    expect(record.mock.calls[1][0]).toEqual({ ok: true, at: '2026-10-01T09:00:00.000Z', glofox_member_id: 'gm1', purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    expect(record.mock.invocationCallOrder[1]).toBeGreaterThan(purchaseGlofoxMembership.mock.invocationCallOrder[0])
  })

  it('the marker could not be recorded → TRIAL_GRANT_UNRECORDED, nothing bought', async () => {
    record.mockResolvedValueOnce(false)

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(false)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNRECORDED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('no recorder at all is treated as unrecorded (fail safe: nothing bought)', async () => {
    const out = await grantTrialBeforeBooking(db, { ...base, record: undefined })

    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNRECORDED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('the outcome could not be recorded after a granted purchase → still proceeds (the marker already guards a retry)', async () => {
    record.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(out.grant).toMatchObject({ ok: true, invoice_id: 'inv-1' })
  })

  it('a purchasing marker with no outcome and no credits → TRIAL_GRANT_UNVERIFIED, nothing bought', async () => {
    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z' }, isRetry: true })

    expect(out.proceed).toBe(false)
    expect(out.failure).toMatchObject({ ok: false, message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('a purchasing marker is refused even when the retry flag is missing and the balance is unreadable', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: false, credits: [] })

    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z' } })

    expect(out.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a purchasing marker WITH credits on the account → proceed, nothing bought (the earlier trial, or a hand-added credit)', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 1 }] })

    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z' }, isRetry: true })

    expect(out).toMatchObject({ proceed: true, grant: { ok: true, skipped: 'credits_present' } })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('no answer from Glofox (network) → failed with outcome_unknown, and a later retry with no credits refuses to buy', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 0, message_code: null, purchase_status: null, error: 'socket hang up' })

    const first = await grantTrialBeforeBooking(db, base)

    expect(first.failure).toMatchObject({ message_code: TRIAL_GRANT_FAILED, outcome_unknown: true })
    expect(first.grant).toMatchObject({ ok: false, outcome_unknown: true })

    vi.clearAllMocks()
    const retry = await grantTrialBeforeBooking(db, { ...base, priorGrant: first.grant, isRetry: true })

    expect(retry.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a 5xx from the purchase is an unknown outcome too (GLOFOXPOSTRETRY.1): a retry with no credits refuses to buy', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 503, message_code: null, purchase_status: null, outcome_unknown: true, error: 'Glofox HTTP 503' })

    const first = await grantTrialBeforeBooking(db, base)

    expect(first.failure).toMatchObject({ message_code: TRIAL_GRANT_FAILED, http_status: 503, outcome_unknown: true })
    expect(first.grant).toMatchObject({ ok: false, outcome_unknown: true })

    vi.clearAllMocks()
    const retry = await grantTrialBeforeBooking(db, { ...base, priorGrant: first.grant, isRetry: true })

    expect(retry.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  // GLOFOXPOSTRETRY.1 review — the mint path's purchase got no clear answer,
  // and the processor stamped that on the card: its FIRST approval (not a
  // retry) must not buy blind either.
  it('a FIRST approval of a card stamped unsettled at the mint: no credits → refuses, nothing bought', async () => {
    const stamped = { ok: false, code: TRIAL_GRANT_FAILED, outcome_unknown: true }
    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: stamped, isRetry: false })
    expect(out.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED, outcome_unknown: true })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a throw AFTER the marker is an unknown outcome too; a throw before it is not', async () => {
    purchaseGlofoxMembership.mockRejectedValueOnce(new Error('kaboom'))
    const after = await grantTrialBeforeBooking(db, base)
    expect(after.grant).toMatchObject({ ok: false, outcome_unknown: true })

    fetchUserCreditsResult.mockRejectedValueOnce(new Error('kaboom'))
    const before = await grantTrialBeforeBooking(db, base)
    expect(before.grant.outcome_unknown).toBeUndefined()
  })

  it('a REFUSED purchase (Glofox answered) is a known outcome: a retry may buy again', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 200, message_code: 'PURCHASE_NOT_ALLOWED', purchase_status: 'ERROR' })
    const first = await grantTrialBeforeBooking(db, base)
    expect(first.grant.outcome_unknown).toBeUndefined()

    const retry = await grantTrialBeforeBooking(db, { ...base, priorGrant: first.grant, isRetry: true })
    expect(retry.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(2)
  })

  // The route's final write REPLACES details.trial_grant with this attempt's
  // grant, so the "may have been bought" state must travel with it, or the
  // NEXT retry would read a plain failure and buy.
  it('an unsettled purchase stays unsettled across retries (the refusal carries it forward)', async () => {
    const first = await grantTrialBeforeBooking(db, { ...base, priorGrant: { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z' }, isRetry: true })
    expect(first.grant).toMatchObject({ ok: false, code: TRIAL_GRANT_UNVERIFIED, outcome_unknown: true })

    const second = await grantTrialBeforeBooking(db, { ...base, priorGrant: first.grant, isRetry: true })

    expect(second.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('credits found after an unsettled purchase book, but the skip keeps the doubt for a later retry', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 1 }] })
    const first = await grantTrialBeforeBooking(db, { ...base, priorGrant: { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z' }, isRetry: true })
    expect(first).toMatchObject({ proceed: true, grant: { ok: true, skipped: 'credits_present', outcome_unknown: true } })

    const later = await grantTrialBeforeBooking(db, { ...base, priorGrant: first.grant, isRetry: true })

    expect(later.failure).toMatchObject({ message_code: TRIAL_GRANT_UNVERIFIED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })
})

// TRIALPURCHASE.2 (a) — the funnel block's own trial reached the approve only
// when routeToReview stamped it on a card it INSERTED. A card it reused (a
// pending card already open for the same person and class) or one filed
// before TRIALGRANT.1 carries none, and the approve bought the location
// default. The queue row that points at the card holds the funnel's choice
// (class_booking_requests.trial_membership_id/trial_plan_code, captured from
// the class_funnel block), so the approve reads it there when the card has none.
describe('grantTrialBeforeBooking: the funnel trial when the card carries none (TRIALPURCHASE.2 a)', () => {
  const queueRow = (over = {}) => ({ id: 'cbr-1', location_id: 'L1', approval_request_id: 'amr-1', trial_membership_id: 'tm-funnel', trial_plan_code: 'tp-funnel', ...over })

  it('reads the funnel trial off the queue row that points at this card, and buys THAT (no settings read)', async () => {
    db = makeDb({ class_booking_requests: [queueRow(), queueRow({ id: 'cbr-other', approval_request_id: 'amr-9', trial_membership_id: 'tm-x', trial_plan_code: 'tp-x' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-funnel', 'tp-funnel')
    expect(readGlofoxConfig).not.toHaveBeenCalled()
    expect(out.proceed).toBe(true)
  })

  it('a queue row with no funnel trial (or a half one) → the location default', async () => {
    db = makeDb({ class_booking_requests: [queueRow({ trial_membership_id: null, trial_plan_code: null }), queueRow({ id: 'cbr-2', trial_plan_code: null })] })

    await grantTrialBeforeBooking(db, base)

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-1', 'tp-1')
  })

  it('a queue row at ANOTHER studio never supplies the trial (nor makes two rows disagree)', async () => {
    db = makeDb({ class_booking_requests: [queueRow({ id: 'cbr-far', location_id: 'L2', trial_membership_id: 'tm-far', trial_plan_code: 'tp-far' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-1', 'tp-1')

    vi.clearAllMocks()
    db = makeDb({ class_booking_requests: [queueRow(), queueRow({ id: 'cbr-far', location_id: 'L2', trial_membership_id: 'tm-far', trial_plan_code: 'tp-far' })] })

    const both = await grantTrialBeforeBooking(db, base)

    expect(both.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-funnel', 'tp-funnel')
  })

  it('the queue row cannot be read → TRIAL_PRODUCT_UNKNOWN, nothing bought (never a guess at the default)', async () => {
    db = makeDb({ class_booking_requests: { error: { message: 'boom' } } })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(false)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_PRODUCT_UNKNOWN })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('two queue rows on this card naming DIFFERENT trials → TRIAL_PRODUCT_UNKNOWN, nothing bought', async () => {
    db = makeDb({ class_booking_requests: [queueRow(), queueRow({ id: 'cbr-2', trial_membership_id: 'tm-other', trial_plan_code: 'tp-other' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_PRODUCT_UNKNOWN })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('an override on the card wins and the queue row is not read at all', async () => {
    db = makeDb({ class_booking_requests: { error: { message: 'boom' } } })

    const out = await grantTrialBeforeBooking(db, { ...base, trialOverride: { membershipId: 'tm-card', planCode: 'tp-card' } })

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-card', 'tp-card')
    expect(db.reads).not.toContain('class_booking_requests')
  })
})

// TRIALPURCHASE.2 (d) — the grant was recorded per CARD. Two cards for
// different classes, approved in turn, each saw only its own record: once the
// first trial's credits were used, the second approval read no credits and
// bought a SECOND trial (one person had 3 cards on 23 Aug). The grant now
// carries the Glofox member id, and a purchase first looks for a grant on any
// OTHER card for the same member at the same studio.
describe('grantTrialBeforeBooking: one trial per member, not per card (TRIALPURCHASE.2 d)', () => {
  const card = (id, over = {}) => ({ id, location_id: 'L1', kind: 'class_booking', status: 'pending', details: {}, ...over })
  // The route's recorder, against the fake table: write details.trial_grant
  // on THIS card.
  const recorderFor = (fake, id) => vi.fn(async (trialGrant) => {
    const row = fake.tables.agent_membership_requests.find((r) => r.id === id)
    row.details = { ...row.details, trial_grant: trialGrant }
    return true
  })

  it('a second card for the SAME member, approved after the first, buys no second trial and goes to staff', async () => {
    db = makeDb({ agent_membership_requests: [card('amr-A'), card('amr-B')] })

    const first = await grantTrialBeforeBooking(db, { ...base, requestId: 'amr-A', record: recorderFor(db, 'amr-A') })
    expect(first.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)

    // The first trial's credit has been used by the time card B is approved.
    const second = await grantTrialBeforeBooking(db, { ...base, requestId: 'amr-B', record: recorderFor(db, 'amr-B') })

    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(second.proceed).toBe(false)
    expect(second.failure).toEqual({ ok: false, message_code: TRIAL_ALREADY_GRANTED, prior_request_id: 'amr-A' })
    expect(second.grant).toMatchObject({ ok: false, code: TRIAL_ALREADY_GRANTED, glofox_member_id: 'gm1', prior_request_id: 'amr-A' })
  })

  it('different members each buy their own trial', async () => {
    db = makeDb({ agent_membership_requests: [card('amr-A'), card('amr-B')] })

    const a = await grantTrialBeforeBooking(db, { ...base, requestId: 'amr-A', memberId: 'gm1', record: recorderFor(db, 'amr-A') })
    const b = await grantTrialBeforeBooking(db, { ...base, requestId: 'amr-B', memberId: 'gm2', record: recorderFor(db, 'amr-B') })

    expect(a.proceed).toBe(true)
    expect(b.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(2)
    expect(purchaseGlofoxMembership).toHaveBeenNthCalledWith(2, creds, 'gm2', 'tm-1', 'tp-1')
  })

  it('another card whose purchase is UNSETTLED for this member (marker, or no clear answer) blocks a purchase too', async () => {
    for (const trialGrant of [
      { stage: 'purchasing', at: '2026-09-30T18:00:00.000Z', glofox_member_id: 'gm1' },
      { ok: false, code: TRIAL_GRANT_FAILED, outcome_unknown: true, glofox_member_id: 'gm1' },
    ]) {
      vi.clearAllMocks()
      db = makeDb({ agent_membership_requests: [card('amr-A', { details: { trial_grant: trialGrant } }), card('amr-1')] })

      const out = await grantTrialBeforeBooking(db, base)

      expect(out.failure).toMatchObject({ message_code: TRIAL_ALREADY_GRANTED, prior_request_id: 'amr-A' })
      expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    }
  })

  it('another card that bought NOTHING for this member (a refusal Glofox answered, or a credits skip) does not block', async () => {
    db = makeDb({ agent_membership_requests: [
      card('amr-A', { details: { trial_grant: { ok: false, code: TRIAL_GRANT_FAILED, glofox_message_code: 'PURCHASE_NOT_ALLOWED', glofox_member_id: 'gm1' } } }),
      card('amr-C', { details: { trial_grant: { ok: true, skipped: 'credits_present', glofox_member_id: 'gm1' } } }),
    ] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('a trial granted for the same member id at ANOTHER studio does not block', async () => {
    db = makeDb({ agent_membership_requests: [card('amr-A', { location_id: 'L2', details: { trial_grant: { ok: true, glofox_member_id: 'gm1' } } })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('credits on the account still book with no purchase, whatever other cards say', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 1 }] })
    db = makeDb({ agent_membership_requests: [card('amr-A', { details: { trial_grant: { ok: true, glofox_member_id: 'gm1' } } })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out).toMatchObject({ proceed: true, grant: { ok: true, skipped: 'credits_present' } })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('the other cards cannot be read → TRIAL_HISTORY_UNREADABLE, nothing bought (a failed read is not "no earlier trial")', async () => {
    db = makeDb({ agent_membership_requests: { error: { message: 'boom' } } })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_HISTORY_UNREADABLE })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})

// A trial bought when the /start mint CREATED the account is recorded only in
// glofox_push_events (status 'created'), never on a card. Every create path
// attaches the trial, and a trial that did not attach lands 'needs_review'
// instead, so a 'created' row for this member at this studio is a trial
// already bought: a later needs_credit_grant card must not buy another.
describe('grantTrialBeforeBooking: a trial bought when the account was minted', () => {
  const minted = (over = {}) => ({ id: 'gpe-1', location_id: 'L1', glofox_member_id: 'gm1', status: 'created', ...over })

  it('a member minted WITH a trial, then filing a needs_credit_grant card, buys no second trial', async () => {
    db = makeDb({ glofox_push_events: [minted()] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(out.proceed).toBe(false)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_ALREADY_GRANTED, prior_push_event_id: 'gpe-1' })
    expect(out.grant).toMatchObject({ ok: false, code: TRIAL_ALREADY_GRANTED, glofox_member_id: 'gm1', prior_push_event_id: 'gpe-1' })
  })

  it('a member minted WITHOUT a trial (the purchase failed: needs_review) buys normally', async () => {
    db = makeDb({ glofox_push_events: [minted({ status: 'needs_review' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('an account that was LINKED (no mint, no trial) buys normally', async () => {
    db = makeDb({ glofox_push_events: [minted({ status: 'linked' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('a mint for the same member id at ANOTHER studio, or for another member, does not block', async () => {
    db = makeDb({ glofox_push_events: [minted({ location_id: 'L2' }), minted({ id: 'gpe-2', glofox_member_id: 'gm2' })] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('credits on the account still book with no purchase', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 1 }] })
    db = makeDb({ glofox_push_events: [minted()] })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out).toMatchObject({ proceed: true, grant: { ok: true, skipped: 'credits_present' } })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('the mint history cannot be read → TRIAL_HISTORY_UNREADABLE, nothing bought', async () => {
    db = makeDb({ glofox_push_events: { error: { message: 'boom' } } })

    const out = await grantTrialBeforeBooking(db, base)

    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_HISTORY_UNREADABLE })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})

// TRIALCLAIM.1 (C113) — one live claim per (studio, Glofox member), taken
// atomically before the purchase. Two cards for one member approved at the
// same instant both passed the history reads above (neither had recorded
// anything yet) and both bought; the claim's unique index (mig 697) lets
// exactly one through. Never buy on an unknown claim state.
describe('grantTrialBeforeBooking: the atomic trial claim (TRIALCLAIM.1)', () => {
  const live = (rows) => rows.filter((r) => r.released_at == null)

  it('claims before buying: the claim names the studio, member and card, and lands before the marker', async () => {
    const order = []
    record.mockImplementation(async (g) => { order.push(['record', g.stage || 'outcome']); return true })
    purchaseGlofoxMembership.mockImplementationOnce(async () => { order.push(['purchase']); return { ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' } })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.proceed).toBe(true)
    expect(db.tables.glofox_trial_claims).toEqual([expect.objectContaining({
      location_id: 'L1', glofox_member_id: 'gm1', request_id: 'amr-1', source: 'approval', released_at: null,
    })])
    const claimAt = db.writes.findIndex((w) => w.table === 'glofox_trial_claims' && w.op === 'insert')
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([['record', 'purchasing'], ['purchase'], ['record', 'outcome']])
  })

  it('two cards for one member approved together: exactly ONE purchase; the other stops TRIAL_ALREADY_GRANTED', async () => {
    // Both read the history before either wrote anything (the real race).
    let release
    const gate = new Promise((r) => { release = r })
    let readsDone = 0
    fetchUserCreditsResult.mockImplementation(async () => {
      readsDone += 1
      if (readsDone === 2) release()
      await gate
      return { ok: true, credits: [] }
    })
    const [a, b] = await Promise.all([
      grantTrialBeforeBooking(db, { ...base, requestId: 'amr-A' }),
      grantTrialBeforeBooking(db, { ...base, requestId: 'amr-B' }),
    ])
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    const [won, lost] = a.proceed ? [a, b] : [b, a]
    expect(won.proceed).toBe(true)
    expect(lost.proceed).toBe(false)
    expect(lost.failure).toEqual({ ok: false, message_code: TRIAL_ALREADY_GRANTED, prior_claim_id: 'claim-1', prior_request_id: a.proceed ? 'amr-A' : 'amr-B' })
    expect(live(db.tables.glofox_trial_claims)).toHaveLength(1)
  })

  it('a live claim from a /start mint (no card) stops the purchase with its push event', async () => {
    db = makeDb({ glofox_trial_claims: [{ id: 'claim-m', location_id: 'L1', glofox_member_id: 'gm1', request_id: null, push_event_id: 'gpe-1', released_at: null }] })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_ALREADY_GRANTED, prior_claim_id: 'claim-m', prior_push_event_id: 'gpe-1' })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a claim seeded from an old grant (before member ids were recorded) stops the purchase', async () => {
    db = makeDb({ glofox_trial_claims: [{ id: 'claim-o', location_id: 'L1', glofox_member_id: 'gm1', request_id: 'amr-old', push_event_id: null, released_at: null, source: 'approval_backfill' }] })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_ALREADY_GRANTED, prior_claim_id: 'claim-o', prior_request_id: 'amr-old' })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('THIS card already holds the live claim (a retry after a clear refusal whose release was lost) → buys', async () => {
    db = makeDb({ glofox_trial_claims: [{ id: 'claim-own', location_id: 'L1', glofox_member_id: 'gm1', request_id: 'amr-1', released_at: null }] })
    const out = await grantTrialBeforeBooking(db, { ...base, priorGrant: { ok: false, code: TRIAL_GRANT_FAILED }, isRetry: true })
    expect(out.proceed).toBe(true)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(db.tables.glofox_trial_claims).toHaveLength(1)
  })

  it('a released claim does not count: the member may be claimed again', async () => {
    db = makeDb({ glofox_trial_claims: [{ id: 'claim-r', location_id: 'L1', glofox_member_id: 'gm1', request_id: 'amr-X', released_at: '2026-09-30T10:00:00.000Z' }] })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.proceed).toBe(true)
    expect(live(db.tables.glofox_trial_claims)).toEqual([expect.objectContaining({ request_id: 'amr-1' })])
  })

  it('another member or another studio is no conflict', async () => {
    db = makeDb({ glofox_trial_claims: [
      { id: 'c-a', location_id: 'L1', glofox_member_id: 'gm2', request_id: 'amr-X', released_at: null },
      { id: 'c-b', location_id: 'L2', glofox_member_id: 'gm1', request_id: 'amr-Y', released_at: null },
    ] })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.proceed).toBe(true)
  })

  it('the claim cannot be written (a database error, or 697 not applied yet) → TRIAL_GRANT_UNRECORDED, nothing bought, no marker', async () => {
    db = makeDb({}, { insert: { glofox_trial_claims: { code: '42P01', message: 'relation "public.glofox_trial_claims" does not exist' } } })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNRECORDED })
    expect(record).not.toHaveBeenCalled()
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a conflict whose holder cannot be read → TRIAL_HISTORY_UNREADABLE, nothing bought', async () => {
    db = makeDb({ glofox_trial_claims: [{ id: 'c-a', location_id: 'L1', glofox_member_id: 'gm1', request_id: 'amr-X', released_at: null }] },
      { read: { glofox_trial_claims: { message: 'boom' } } })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_HISTORY_UNREADABLE })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a conflict whose holder has gone by the re-read (released meanwhile) → TRIAL_HISTORY_UNREADABLE, never a guess', async () => {
    db = makeDb({}, { insert: { glofox_trial_claims: { code: '23505', message: 'duplicate key value violates unique constraint "glofox_trial_claims_one_live"' } } })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_HISTORY_UNREADABLE })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('no card id (no owner to claim for) → TRIAL_GRANT_UNRECORDED, nothing bought', async () => {
    const out = await grantTrialBeforeBooking(db, { ...base, requestId: null })
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNRECORDED })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('Glofox answered a clear refusal → the claim is released (nothing was bought), so the next card may buy', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 200, message_code: 'PURCHASE_NOT_ALLOWED', purchase_status: 'ERROR' })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure.message_code).toBe(TRIAL_GRANT_FAILED)
    expect(live(db.tables.glofox_trial_claims)).toEqual([])
    expect(db.tables.glofox_trial_claims[0]).toMatchObject({ release_reason: 'purchase_refused', released_at: '2026-10-01T09:00:00.000Z' })
  })

  it('no clear answer from Glofox (outcome_unknown) → the claim STANDS', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 502, outcome_unknown: true })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toMatchObject({ message_code: TRIAL_GRANT_FAILED, outcome_unknown: true })
    expect(live(db.tables.glofox_trial_claims)).toHaveLength(1)
  })

  it('a purchase that throws after it was sent → the claim STANDS', async () => {
    purchaseGlofoxMembership.mockRejectedValueOnce(new Error('socket hang up'))
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toMatchObject({ message_code: TRIAL_GRANT_FAILED, outcome_unknown: true })
    expect(live(db.tables.glofox_trial_claims)).toHaveLength(1)
  })

  it('the write-ahead marker cannot be written → the claim is released (nothing was bought)', async () => {
    record.mockResolvedValueOnce(false)
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure).toEqual({ ok: false, message_code: TRIAL_GRANT_UNRECORDED })
    expect(live(db.tables.glofox_trial_claims)).toEqual([])
    expect(db.tables.glofox_trial_claims[0].release_reason).toBe('marker_unrecorded')
  })

  it('a lost release is logged and the claim stands (the next card stops, closed)', async () => {
    db = makeDb({}, { update: { glofox_trial_claims: { message: 'boom' } } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 200, message_code: 'PURCHASE_NOT_ALLOWED', purchase_status: 'ERROR' })
    const out = await grantTrialBeforeBooking(db, base)
    expect(out.failure.message_code).toBe(TRIAL_GRANT_FAILED)
    expect(live(db.tables.glofox_trial_claims)).toHaveLength(1)
    expect(logWarn).toHaveBeenCalledWith('trial-grant', 'trial claim not released; the next card for this member will stop for staff', { requestId: 'amr-1', reason: 'purchase_refused' })
  })

  it('stops before the product is known take no claim (a settings read failure, no trial set, credits present)', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: { message: 'boom' } })
    await grantTrialBeforeBooking(db, base)
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: null })
    await grantTrialBeforeBooking(db, base)
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: true, credits: [{ available: 2 }] })
    await grantTrialBeforeBooking(db, base)
    expect(db.writes.filter((w) => w.table === 'glofox_trial_claims')).toEqual([])
  })
})
