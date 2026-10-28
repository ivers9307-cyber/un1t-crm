// UN1TDUN.1 — payment reminders at a un1t.online studio (Hatch Street).
//
// The trouble comes only from the mirror through the read seam (pastDue,
// faked here at its module boundary); enrolment, the status write, the exit
// and the customer host are faked at theirs. The supabase double filters for
// real, so a read that names the wrong location or sequence finds nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/membership/reads/un1t-online', () => ({ un1tOnlineReads: { pastDue: vi.fn() } }))
vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/sequences/enrollment-status', () => ({ setEnrollmentStatus: vi.fn() }))
vi.mock('@/lib/dunning', () => ({ exitDunningForContact: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { un1tOnlineReads } from '@/lib/membership/reads/un1t-online'
import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/enrollment-status'
import { exitDunningForContact } from '@/lib/dunning'
import { logWarn } from '@/lib/log'
import {
  pickUn1tTrouble,
  un1tPaymentForRun,
  maybeEnrolUn1tDunning,
  un1tDunningPresendGate,
  runUn1tDunningStep,
  newUn1tPayToken,
  UN1T_PAY_PATH,
  UN1T_DUNNING_ENROL_CAP,
} from './un1t-dunning.js'
import { PRESEND_EXIT_REASON } from './dunning-payment.js'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const SEQ = 'seq-hatch'
const NOW = Date.parse('2026-10-28T10:00:00Z')

const row = (over = {}) => ({
  contactId: 'c1', un1tUserId: 'u1', subscriptionId: 'sub-1', productTitle: 'Monthly',
  since: '2026-10-20T08:00:00Z', amountCents: 18900, currency: 'EUR', openInvoiceIds: ['inv-1'],
  cancelAtPeriodEnd: false, pausedUntil: null, ...over,
})

// A small chainable supabase double: eq / in really filter, writes are refused.
function fakeDb(tables = {}, { errors = {} } = {}) {
  const calls = []
  const valueOf = (r, col) => {
    if (!col.includes('->')) return r[col]
    const parts = col.split(/->>?/)
    let v = r
    for (const p of parts) v = v == null ? undefined : v[p]
    return v == null ? null : String(v)
  }
  const from = (table) => {
    const filters = []
    const call = { table, cols: null, filters: [] }
    calls.push(call)
    let limitN = null
    const run = () => {
      if (errors[table]) return { data: null, error: { message: `${table} boom` } }
      let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
      if (limitN != null) rows = rows.slice(0, limitN)
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const b = {
      select(cols) { call.cols = cols; return b },
      eq(col, val) { call.filters.push(['eq', col, val]); filters.push((r) => valueOf(r, col) === val); return b },
      in(col, vals) { call.filters.push(['in', col, vals]); filters.push((r) => vals.includes(r[col])); return b },
      order() { return b },
      limit(n) { limitN = n; return b },
      range(a, z) { const r = run(); return Promise.resolve(r.error ? r : { data: r.data.slice(a, z + 1), error: null }) },
      async maybeSingle() { const r = run(); return r.error ? r : { data: r.data[0] ?? null, error: null } },
      update() { throw new Error('this double refuses writes') },
      insert() { throw new Error('this double refuses writes') },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { from, calls }
}

const hatchLoc = (over = {}) => ({ id: HATCH, membership_source: 'un1t_online', dunning_sequence_id: SEQ, dunning_auto_enroll: true, ...over })
const activeSeq = (over = {}) => ({ id: SEQ, name: 'Hatch reminders', status: 'active', location_id: HATCH, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row()] })
  enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0, reactivated: 0 })
  exitDunningForContact.mockResolvedValue({ exited: 1 })
  setEnrollmentStatus.mockResolvedValue(undefined)
})

describe('pickUn1tTrouble', () => {
  it('a membership row with an open invoice is trouble: the newest open invoice, its amount when it is the only one', () => {
    expect(pickUn1tTrouble([row()], 'c1', NOW)).toEqual({
      trouble: {
        invoiceId: 'inv-1', subscriptionId: 'sub-1', un1tUserId: 'u1', since: '2026-10-20T08:00:00Z',
        amountCents: 18900, currency: 'EUR', openInvoiceIds: ['inv-1'],
      },
      reason: null,
    })
    const two = pickUn1tTrouble([row({ openInvoiceIds: ['inv-old', 'inv-new'], amountCents: 37800 })], 'c1', NOW)
    expect(two.trouble.invoiceId).toBe('inv-new')
    // A sum of two invoices is not this invoice's amount.
    expect(two.trouble.amountCents).toBeNull()
  })

  it('only the contact asked about', () => {
    expect(pickUn1tTrouble([row({ contactId: 'c2' })], 'c1', NOW)).toEqual({ trouble: null, reason: 'not_behind' })
    expect(pickUn1tTrouble([], 'c1', NOW)).toEqual({ trouble: null, reason: 'not_behind' })
    expect(pickUn1tTrouble(null, 'c1', NOW)).toEqual({ trouble: null, reason: 'not_behind' })
  })

  it('never a non-membership invoice, a flag with no open invoice, a cancelling or a paused member', () => {
    expect(pickUn1tTrouble([row({ subscriptionId: null })], 'c1', NOW).reason).toBe('not_membership_invoice')
    expect(pickUn1tTrouble([row({ openInvoiceIds: [] })], 'c1', NOW).reason).toBe('no_open_invoice')
    expect(pickUn1tTrouble([row({ cancelAtPeriodEnd: true })], 'c1', NOW).reason).toBe('cancelling')
    expect(pickUn1tTrouble([row({ pausedUntil: '2026-11-30T00:00:00Z' })], 'c1', NOW).reason).toBe('member_paused')
    // A pause that has ended is not a pause; an unreadable one fails closed.
    expect(pickUn1tTrouble([row({ pausedUntil: '2026-10-01T00:00:00Z' })], 'c1', NOW).trouble).not.toBeNull()
    expect(pickUn1tTrouble([row({ pausedUntil: 'soon' })], 'c1', NOW).reason).toBe('member_paused')
  })

  it('a second subscription that qualifies wins over one that does not', () => {
    const out = pickUn1tTrouble([row({ cancelAtPeriodEnd: true }), row({ subscriptionId: 'sub-2', openInvoiceIds: ['inv-2'] })], 'c1', NOW)
    expect(out.trouble.invoiceId).toBe('inv-2')
  })
})

describe('un1tPaymentForRun', () => {
  it('keeps the Glofox shape: our short link on the studio host, the token as the button suffix, the amount formatted', async () => {
    const db = fakeDb()
    const p = await un1tPaymentForRun(db, {
      locationId: HATCH, now: new Date(NOW), token: 'tok_abcdefghijklmnopqrstuv',
      trouble: { invoiceId: 'inv-1', amountCents: 18900, currency: 'EUR' },
    })
    expect(p).toEqual({
      invoice_id: 'inv-1',
      link: `https://hatch.example.test${UN1T_PAY_PATH}tok_abcdefghijklmnopqrstuv`,
      link_suffix: 'tok_abcdefghijklmnopqrstuv',
      amount: '€189',
      currency: 'EUR',
      retriable: false,
      fetched_at: new Date(NOW).toISOString(),
      error: null,
      platform: 'un1t_online',
    })
  })

  it('no amount known: an empty amount, never an estimate', async () => {
    const p = await un1tPaymentForRun(fakeDb(), { locationId: HATCH, token: 'tok_abcdefghijklmnopqrstuv', trouble: { invoiceId: 'inv-1', amountCents: null, currency: null } })
    expect(p.amount).toBe('')
    expect(p.currency).toBeNull()
  })

  it('a fresh token is random base64url of at least 16 bytes', () => {
    const a = newUn1tPayToken()
    const b = newUn1tPayToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(a).not.toBe(b)
  })
})

describe('maybeEnrolUn1tDunning', () => {
  const tables = (over = {}) => ({ locations: [hatchLoc()], email_sequences: [activeSeq()], sequence_enrollments: [], un1t_invoices: [], ...over })

  it('enrols on the open invoice with the run payment, idempotent per invoice (source ref), allowReenrol', async () => {
    const res = await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, 'c1', { token: 'tok_abcdefghijklmnopqrstuv' })
    expect(res).toMatchObject({ enrolled: 1, invoice_id: 'inv-1', sequence_id: SEQ })
    expect(un1tOnlineReads.pastDue).toHaveBeenCalledWith(expect.anything(), HATCH, { contactIds: ['c1'] })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: SEQ,
      contactIds: ['c1'],
      sourceType: 'invoice_past_due',
      sourceRef: 'inv-1',
      allowReenrol: true,
      metadata: { payment: expect.objectContaining({ invoice_id: 'inv-1', link_suffix: 'tok_abcdefghijklmnopqrstuv', platform: 'un1t_online', amount: '€189' }) },
    })
  })

  it('a run that already carries this invoice is left alone (one automatic run per invoice), whatever its status', async () => {
    for (const status of ['active', 'completed', 'exited']) {
      enrolContacts.mockClear()
      const db = fakeDb(tables({ sequence_enrollments: [{ id: 'e1', sequence_id: SEQ, contact_id: 'c1', status, metadata: { payment: { invoice_id: 'inv-1' } } }] }))
      expect(await maybeEnrolUn1tDunning(db, HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'already_enrolled', status })
      expect(enrolContacts).not.toHaveBeenCalled()
    }
  })

  it('a manual click chases the same unpaid invoice again once its run has finished, never while it is active', async () => {
    for (const [status, enrols] of [['active', false], ['completed', true], ['exited', true]]) {
      enrolContacts.mockClear()
      const db = fakeDb(tables({ sequence_enrollments: [{ id: 'e1', sequence_id: SEQ, contact_id: 'c1', status, metadata: { payment: { invoice_id: 'inv-1' } } }] }))
      await maybeEnrolUn1tDunning(db, HATCH, 'c1', { manual: true })
      if (enrols) expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'churn_radar', sourceRef: 'inv-1', allowReenrol: true }))
      else expect(enrolContacts).not.toHaveBeenCalled()
    }
  })

  it('a run on ANOTHER sequence or contact does not count', async () => {
    const db = fakeDb(tables({ sequence_enrollments: [{ id: 'e1', sequence_id: 'other', contact_id: 'c1', status: 'active', metadata: { payment: { invoice_id: 'inv-1' } } }] }))
    expect((await maybeEnrolUn1tDunning(db, HATCH, 'c1')).enrolled).toBe(1)
  })

  it('an active run on an older invoice: enrolContacts no-ops, reported, not refreshed', async () => {
    enrolContacts.mockResolvedValue({ enrolled: 0, skipped: 1, reactivated: 0 })
    const db = fakeDb(tables({ sequence_enrollments: [{ id: 'e1', sequence_id: SEQ, contact_id: 'c1', status: 'active', metadata: { payment: { invoice_id: 'inv-0' } } }] }))
    expect(await maybeEnrolUn1tDunning(db, HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'active_run_other_invoice' })
  })

  it('with two open invoices the chased one\'s own amount is read from the mirror at this studio', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row({ openInvoiceIds: ['inv-0', 'inv-1'], amountCents: 37800 })] })
    const db = fakeDb(tables({ un1t_invoices: [
      { location_id: STILL, un1t_id: 'inv-1', amount_cents: 1, currency: 'eur' },
      { location_id: HATCH, un1t_id: 'inv-1', amount_cents: 18900, currency: 'eur' },
    ] }))
    await maybeEnrolUn1tDunning(db, HATCH, 'c1')
    expect(enrolContacts.mock.calls[0][0].metadata.payment.amount).toBe('€189')
  })

  it('gates: auto-enrol off, no sequence, a paused / foreign sequence, a non-un1t studio', async () => {
    const cases = [
      [tables({ locations: [hatchLoc({ dunning_auto_enroll: false })] }), 'auto_enroll_off'],
      [tables({ locations: [hatchLoc({ dunning_sequence_id: null })] }), 'no_dunning_sequence'],
      [tables({ email_sequences: [activeSeq({ status: 'paused' })] }), 'sequence_paused'],
      [tables({ email_sequences: [activeSeq({ location_id: STILL })] }), 'sequence_unavailable'],
      [tables({ email_sequences: [] }), 'sequence_unavailable'],
      [tables({ locations: [hatchLoc({ membership_source: 'glofox' })] }), 'not_un1t_studio'],
    ]
    for (const [t, reason] of cases) {
      expect(await maybeEnrolUn1tDunning(fakeDb(t), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason })
    }
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(un1tOnlineReads.pastDue).not.toHaveBeenCalled()
  })

  it('manual: enrols with auto-enrol off, as churn_radar (the Glofox manual path ignores the flag too)', async () => {
    const res = await maybeEnrolUn1tDunning(fakeDb(tables({ locations: [hatchLoc({ dunning_auto_enroll: false })] })), HATCH, 'c1', { manual: true })
    expect(res.enrolled).toBe(1)
    expect(enrolContacts.mock.calls[0][0]).toMatchObject({ sourceType: 'churn_radar', sourceRef: 'inv-1' })
  })

  it('not behind (from the mirror, never the caller): no enrol', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [] })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'not_behind' })
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row({ pausedUntil: '2026-12-01T00:00:00Z' })] })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'member_paused' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('unreadable reads never enrol and never throw', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: false, error: 'boom' })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'past_due_unreadable' })
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row()] })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables(), { errors: { locations: true } }), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'location_unreadable' })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables(), { errors: { sequence_enrollments: true } }), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'enrolment_unreadable' })
    enrolContacts.mockRejectedValue(new Error('enrol down'))
    expect(await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, 'c1')).toMatchObject({ enrolled: 0, reason: 'threw' })
    expect(await maybeEnrolUn1tDunning(fakeDb(tables()), HATCH, null)).toEqual({ enrolled: 0, reason: 'no_contact' })
  })
})

describe('un1tDunningPresendGate', () => {
  const enrollment = (payment = { invoice_id: 'inv-1', platform: 'un1t_online' }) => ({ id: 'e1', contact_id: 'c1', source_type: 'invoice_past_due', metadata: { payment } })
  const ctx = (over = {}) => ({ enrollment: enrollment(), contact: { id: 'c1' }, sequence: { id: SEQ, location_id: HATCH }, ...over })

  it('invoice still open: proceed, nothing written', async () => {
    expect(await un1tDunningPresendGate(fakeDb(), ctx())).toEqual({ proceed: true })
    expect(un1tOnlineReads.pastDue).toHaveBeenCalledWith(expect.anything(), HATCH, { contactIds: ['c1'] })
    expect(setEnrollmentStatus).not.toHaveBeenCalled()
  })

  it('invoice no longer open: exits the run with the shared presend reason and stops the send', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row({ openInvoiceIds: ['inv-9'] })] })
    expect(await un1tDunningPresendGate(fakeDb(), ctx())).toEqual({ proceed: false, reason: 'invoice no longer overdue' })
    expect(setEnrollmentStatus).toHaveBeenCalledWith({ enrollmentId: 'e1', status: 'exited', reason: PRESEND_EXIT_REASON })
  })

  it('fails open: an unreadable mirror, a throw, or a failed exit write all send', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: false, error: 'boom' })
    expect(await un1tDunningPresendGate(fakeDb(), ctx())).toEqual({ proceed: true })
    un1tOnlineReads.pastDue.mockRejectedValue(new Error('boom'))
    expect(await un1tDunningPresendGate(fakeDb(), ctx())).toEqual({ proceed: true })
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [] })
    setEnrollmentStatus.mockRejectedValue(new Error('write down'))
    expect(await un1tDunningPresendGate(fakeDb(), ctx())).toEqual({ proceed: true })
    expect(logWarn).toHaveBeenCalled()
  })

  it('no invoice on the run, or no studio: proceed without a read', async () => {
    expect(await un1tDunningPresendGate(fakeDb(), ctx({ enrollment: enrollment({ platform: 'un1t_online' }) }))).toEqual({ proceed: true })
    expect(await un1tDunningPresendGate(fakeDb(), ctx({ sequence: { id: SEQ } }))).toEqual({ proceed: true })
    expect(un1tOnlineReads.pastDue).not.toHaveBeenCalled()
  })
})

describe('runUn1tDunningStep (sync step 7d)', () => {
  const run = (id, contactId, payment, over = {}) => ({ id, sequence_id: SEQ, contact_id: contactId, status: 'active', metadata: { payment }, ...over })
  const tables = (over = {}) => ({ locations: [hatchLoc()], email_sequences: [activeSeq()], sequence_enrollments: [], un1t_invoices: [], ...over })

  it('enrols each newly past-due member and exits a un1t run whose invoice is no longer open', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row(), row({ contactId: 'c2', un1tUserId: 'u2', openInvoiceIds: ['inv-2'] })] })
    const db = fakeDb(tables({ sequence_enrollments: [
      run('e-paid', 'c3', { invoice_id: 'inv-3', platform: 'un1t_online' }),
      run('e-open', 'c4', { invoice_id: 'inv-2', platform: 'un1t_online' }),
      // A Glofox-shaped run (no platform) is never judged against the un1t mirror.
      run('e-glofox', 'c5', { invoice_id: 'gf-1' }),
      // Not active: not this step's business.
      run('e-done', 'c6', { invoice_id: 'inv-6', platform: 'un1t_online' }, { status: 'completed' }),
    ] }))
    const counts = await runUn1tDunningStep(db, { locationId: HATCH })
    expect(exitDunningForContact).toHaveBeenCalledTimes(1)
    expect(exitDunningForContact).toHaveBeenCalledWith(db, HATCH, 'c3', 'invoice_paid', { invoiceId: 'inv-3' })
    expect(enrolContacts).toHaveBeenCalledTimes(2)
    expect(counts).toEqual({ enrolled: 2, already: 0, exited: 1, skipped: 0 })
  })

  it('reads the studio-wide past-due set once, through the seam', async () => {
    await runUn1tDunningStep(fakeDb(tables()), { locationId: HATCH })
    expect(un1tOnlineReads.pastDue).toHaveBeenNthCalledWith(1, expect.anything(), HATCH)
  })

  it('a failed past-due read exits nothing and enrols nothing', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: false, error: 'boom' })
    const db = fakeDb(tables({ sequence_enrollments: [run('e1', 'c3', { invoice_id: 'inv-3', platform: 'un1t_online' })] }))
    const counts = await runUn1tDunningStep(db, { locationId: HATCH })
    expect(counts).toEqual({ enrolled: 0, already: 0, exited: 0, skipped: 0, error: 'past_due_unreadable' })
    expect(exitDunningForContact).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('auto-enrol off: exits still run, nothing enrols', async () => {
    const db = fakeDb(tables({ locations: [hatchLoc({ dunning_auto_enroll: false })], sequence_enrollments: [run('e1', 'c3', { invoice_id: 'inv-3', platform: 'un1t_online' })] }))
    const counts = await runUn1tDunningStep(db, { locationId: HATCH })
    expect(counts).toMatchObject({ enrolled: 0, exited: 1, reason: 'auto_enroll_off' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('already-enrolled and refused members are counted, never thrown', async () => {
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: [row(), row({ contactId: 'c2', openInvoiceIds: ['inv-2'] }), row({ contactId: null, openInvoiceIds: ['inv-x'] })] })
    const db = fakeDb(tables({ sequence_enrollments: [run('e1', 'c1', { invoice_id: 'inv-1', platform: 'un1t_online' })] }))
    enrolContacts.mockRejectedValue(new Error('down'))
    const counts = await runUn1tDunningStep(db, { locationId: HATCH })
    expect(counts).toEqual({ enrolled: 0, already: 1, exited: 0, skipped: 1 })
  })

  it('caps the enrolments one run attempts', async () => {
    const many = Array.from({ length: UN1T_DUNNING_ENROL_CAP + 3 }, (_, i) => row({ contactId: `c${i}`, openInvoiceIds: [`inv-${i}`] }))
    un1tOnlineReads.pastDue.mockResolvedValue({ success: true, data: many })
    const counts = await runUn1tDunningStep(fakeDb(tables()), { locationId: HATCH })
    expect(enrolContacts).toHaveBeenCalledTimes(UN1T_DUNNING_ENROL_CAP)
    expect(counts.over_cap).toBe(3)
  })

  it('a studio that is not un1t.online, or has no dunning sequence, does nothing', async () => {
    expect(await runUn1tDunningStep(fakeDb(tables({ locations: [hatchLoc({ membership_source: 'glofox' })] })), { locationId: HATCH })).toEqual({ skipped: 'membership_source' })
    expect(await runUn1tDunningStep(fakeDb(tables({ locations: [hatchLoc({ dunning_sequence_id: null })] })), { locationId: HATCH })).toEqual({ enrolled: 0, already: 0, exited: 0, skipped: 0, reason: 'no_dunning_sequence' })
    expect(un1tOnlineReads.pastDue).not.toHaveBeenCalled()
  })

  it('an unreadable location or run list is recorded, never thrown', async () => {
    expect(await runUn1tDunningStep(fakeDb(tables(), { errors: { locations: true } }), { locationId: HATCH })).toMatchObject({ error: 'location_unreadable' })
    const counts = await runUn1tDunningStep(fakeDb(tables(), { errors: { sequence_enrollments: true } }), { locationId: HATCH })
    expect(counts).toMatchObject({ exit_error: 'runs_unreadable' })
  })
})
