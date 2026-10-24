// TRIALSTUDIO.6 — startUn1tTrialCheckout: the Hatch leg's outcomes the route
// test does not reach. Every un1t.online answer lands the row in exactly one
// judged state; nothing here can charge (only ensureUn1tAccount and
// createCheckoutLink are called, both mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const mocks = vi.hoisted(() => ({ ensureAccount: vi.fn(), checkout: vi.fn(), alert: vi.fn(), updated: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: mocks.ensureAccount }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: mocks.checkout }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: async () => 'https://www.un1tdublin.com' }))
vi.mock('@/lib/trial-purchase-processor', () => ({ alertTrialPurchaseStaff: mocks.alert }))
vi.mock('@/lib/log', () => ({ logError: mocks.logError, logWarn: mocks.logWarn, logInfo: vi.fn() }))

import { startUn1tTrialCheckout } from './trial-purchase-un1t-checkout'

const db = {
  from: (table) => ({
    update: (patch) => {
      const filters = []
      const c = {
        eq: (col, v) => { filters.push([col, v]); return c },
        then: (res, rej) => Promise.resolve(mocks.updated(table, patch, filters)).then((r) => r ?? { error: null }).then(res, rej),
      }
      return c
    },
  }),
}
const ROW = { id: 'tp1', location_id: 'loc2', un1t_product_id: 'prod-1', terms_accepted_at: '2026-10-24T10:00:00.000Z', terms_source: 'website', terms_version: 'v1' }
const ARGS = { row: ROW, location: { id: 'loc2', organization_id: 'org1' }, contact: { id: 'c1', email: 'ava@example.com' } }
const patches = () => mocks.updated.mock.calls.map(([, patch]) => patch)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c1' })
  mocks.checkout.mockResolvedValue({ checkoutUrl: 'https://pay.un1t.online/s/x', free: false, ledgerId: 'led-1' })
  mocks.updated.mockResolvedValue({ error: null })
  mocks.alert.mockResolvedValue(undefined)
})

describe('startUn1tTrialCheckout', () => {
  it('a settings read that failed (nothing sent) marks the row failed, no alert', async () => {
    mocks.ensureAccount.mockRejectedValue(new Un1tSettingsReadError('down', { code: 'connection_read_failed' }))
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'unavailable' })
    expect(patches()).toEqual([{ status: 'failed', last_error: 'connection_read_failed' }])
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.alert).not.toHaveBeenCalled()
  })
  it('a non-retryable refusal thrown by the account step files help; a thrown read error is a retry', async () => {
    mocks.ensureAccount.mockRejectedValueOnce(new Un1tWriteRefused('UN1T_WRITES_OFF', 'off', { retryable: false }))
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches()).toEqual([{ status: 'help_requested', last_error: 'un1t_account_refused: UN1T_WRITES_OFF' }])
    expect(mocks.alert).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'tp1', status: 'help_requested' }), 'un1t_account_refused', 'UN1T_WRITES_OFF')

    vi.clearAllMocks()
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockRejectedValueOnce(new Error('un1t_clients read failed'))
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'unavailable' })
    expect(patches()).toEqual([{ status: 'failed', last_error: 'un1t_account_unreadable' }])
    expect(mocks.alert).not.toHaveBeenCalled()
  })
  it('a un1t_user_id that cannot be stamped stops before the checkout (the sweeper could never settle it)', async () => {
    mocks.updated.mockResolvedValueOnce({ error: { code: '57014' } })
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'unavailable' })
    expect(patches()).toEqual([{ un1t_user_id: 'u-1' }, { status: 'failed', last_error: 'un1t_user_unstamped' }])
    expect(mocks.checkout).not.toHaveBeenCalled()
  })
  it('an unclear checkout answer files help with its ledger row linked', async () => {
    const err = new Un1tWriteUnknown('outcome_unknown', 'unclear')
    err.ledgerId = 'led-9'
    mocks.checkout.mockRejectedValue(err)
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches()).toEqual([{ un1t_user_id: 'u-1' }, { status: 'help_requested', last_error: 'un1t_outcome_unknown: outcome_unknown', un1t_ledger_id: 'led-9' }])
    expect(mocks.alert).toHaveBeenCalledWith(db, expect.objectContaining({ un1t_ledger_id: 'led-9' }), 'un1t_outcome_unknown', 'outcome_unknown')
  })
  it('a settings read error from the checkout is a retry; a "free" answer goes to staff, never a redirect', async () => {
    mocks.checkout.mockRejectedValueOnce(new Un1tSettingsReadError('host', { code: 'customer_url_unreadable' }))
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'unavailable' })
    expect(patches().at(-1)).toEqual({ status: 'failed', last_error: 'customer_url_unreadable' })

    mocks.checkout.mockResolvedValueOnce({ checkoutUrl: null, free: true, ledgerId: 'led-2' })
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches().at(-1)).toEqual({ status: 'help_requested', last_error: 'un1t_outcome_unknown: checkout_free', un1t_ledger_id: 'led-2' })
  })
  it('a ledger id that cannot be stamped still sends the buyer to pay (settling keys on the user id)', async () => {
    mocks.updated.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { code: '57014' } })
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'redirect', checkoutUrl: 'https://pay.un1t.online/s/x' })
    expect(patches()).toEqual([{ un1t_user_id: 'u-1' }, { un1t_ledger_id: 'led-1' }])
    for (const [, , filters] of mocks.updated.mock.calls) expect(filters).toEqual([['id', 'tp1'], ['location_id', 'loc2']])
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  // Final review — uniq_trial_purchases_open_help (mig 764) also guards this
  // stamp: a buyer who already has an open help card at Hatch.
  it('a help stamp refused 23505 (a card already open) closes the row failed, sends no second alert, still help_filed', async () => {
    mocks.checkout.mockRejectedValue(new Un1tWriteRefused('UN1T_ALREADY_PURCHASED', 'limit', { retryable: false }))
    mocks.updated
      .mockResolvedValueOnce({ error: null }) // un1t_user_id
      .mockResolvedValueOnce({ error: { code: '23505', details: 'Key (location_id, contact_id)=(loc2, c1) already exists.' } })
      .mockResolvedValueOnce({ error: null })
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches()).toEqual([
      { un1t_user_id: 'u-1' },
      { status: 'help_requested', last_error: 'un1t_checkout_refused: UN1T_ALREADY_PURCHASED' },
      { status: 'failed', last_error: 'help_card_already_open' },
    ])
    for (const [, , filters] of mocks.updated.mock.calls) expect(filters).toEqual([['id', 'tp1'], ['location_id', 'loc2']])
    expect(mocks.alert).not.toHaveBeenCalled()
  })
  it('logs ids and codes only, never the raw error', async () => {
    const pgErr = { code: '57014', message: 'canceling statement', details: 'Failing row contains (ava@example.com, 0851234567)' }
    mocks.updated.mockResolvedValueOnce({ error: pgErr }).mockResolvedValueOnce({ error: pgErr })
    expect(await startUn1tTrialCheckout(db, ARGS)).toEqual({ kind: 'unavailable' })
    expect(mocks.logError).toHaveBeenCalledWith('trialbuy', 'un1t user id not stamped; no checkout', { purchaseId: 'tp1', locationId: 'loc2', code: '57014' })
    expect(mocks.logError).toHaveBeenCalledWith('trialbuy', 'un1t trial row not marked failed', { purchaseId: 'tp1', locationId: 'loc2', lastError: 'un1t_user_unstamped', code: '57014' })

    vi.clearAllMocks()
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockRejectedValueOnce(Object.assign(new Error('read failed for ava@example.com'), { code: 'XX000' }))
    await startUn1tTrialCheckout(db, ARGS)
    mocks.checkout.mockRejectedValueOnce(new Error('boom ava@example.com'))
    mocks.alert.mockRejectedValueOnce(new Error('mail down for ava@example.com'))
    await startUn1tTrialCheckout(db, ARGS)
    mocks.updated.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: pgErr })
    await startUn1tTrialCheckout(db, ARGS)
    const logged = JSON.stringify([...mocks.logError.mock.calls, ...mocks.logWarn.mock.calls])
    expect(mocks.logError.mock.calls.length + mocks.logWarn.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(logged).not.toContain('ava@example.com')
    expect(logged).not.toContain('Failing row')
  })
})
