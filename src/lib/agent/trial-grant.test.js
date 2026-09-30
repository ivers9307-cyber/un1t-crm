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

import { grantTrialBeforeBooking, TRIAL_GRANT_FAILED, TRIAL_NOT_CONFIGURED, TRIAL_GRANT_UNVERIFIED } from './trial-grant'
import { fetchUserCreditsResult, purchaseGlofoxMembership } from '@/lib/glofox'
import { readGlofoxConfig } from '@/lib/connection-registry'
import { logError } from '@/lib/log'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const base = { creds, locationId: 'L1', memberId: 'gm1', requestId: 'amr-1', now: () => '2026-10-01T09:00:00.000Z' }
const db = {}

beforeEach(() => {
  vi.clearAllMocks()
  fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
  readGlofoxConfig.mockResolvedValue({ cfg: { trial_membership_id: 'tm-1', trial_plan_code: 'tp-1' }, error: null })
  purchaseGlofoxMembership.mockResolvedValue({ ok: true, http_status: 200, message_code: 'CART_LEGACY_PURCHASE_SUCCESS', purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
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
})
