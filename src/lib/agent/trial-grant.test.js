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

import { grantTrialBeforeBooking, TRIAL_GRANT_FAILED, TRIAL_NOT_CONFIGURED, TRIAL_GRANT_UNVERIFIED, TRIAL_GRANT_UNRECORDED } from './trial-grant'
import { fetchUserCreditsResult, purchaseGlofoxMembership } from '@/lib/glofox'
import { readGlofoxConfig } from '@/lib/connection-registry'
import { logError } from '@/lib/log'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
// The route's write-ahead: persists details.trial_grant on THIS execution
// (a guarded update) and answers whether it landed.
const record = vi.fn()
const base = { creds, locationId: 'L1', memberId: 'gm1', requestId: 'amr-1', record, now: () => '2026-10-01T09:00:00.000Z' }
const db = {}

beforeEach(() => {
  vi.clearAllMocks()
  fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
  readGlofoxConfig.mockResolvedValue({ cfg: { trial_membership_id: 'tm-1', trial_plan_code: 'tp-1' }, error: null })
  purchaseGlofoxMembership.mockResolvedValue({ ok: true, http_status: 200, message_code: 'CART_LEGACY_PURCHASE_SUCCESS', purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
  record.mockReset().mockResolvedValue(true)
})

describe('grantTrialBeforeBooking (TRIALGRANT.1)', () => {
  it('no credits, trial set, purchase granted → proceed, grant recorded with the invoice id', async () => {
    const out = await grantTrialBeforeBooking(db, base)

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(creds, 'gm1', 'tm-1', 'tp-1')
    expect(out).toEqual({ proceed: true, failure: null, grant: { ok: true, at: '2026-10-01T09:00:00.000Z', purchase_status: 'SUCCESS', invoice_id: 'inv-1' } })
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

    expect(out).toEqual({ proceed: true, failure: null, grant: { ok: true, at: '2026-10-01T09:00:00.000Z', skipped: 'credits_present' } })
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
    expect(record.mock.calls[0][0]).toEqual({ stage: 'purchasing', at: '2026-10-01T09:00:00.000Z' })
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(purchaseGlofoxMembership.mock.invocationCallOrder[0])
    expect(record.mock.calls[1][0]).toEqual({ ok: true, at: '2026-10-01T09:00:00.000Z', purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
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
