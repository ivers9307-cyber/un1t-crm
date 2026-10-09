// EVENT-MOVE.5 — the two price-difference emails (the payment link and the
// receipt), and sendRaceConfirmations refusing a move_gap row.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Partial: event-email's merge tags need postmark's real applyMergeTags.
vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => ({ id: 'L-comms' })),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { logError } = await import('./log')
const { sendGapPaidEmail, sendGapLinkEmail, sendRaceConfirmations, buildGapDefaults } = await import('./race-confirmations.js')

const RACE = { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', kind: 'race', race_date: '2026-10-25', location_id: 'L1', host_id: null,
  sending_location_id: null, venue_name: 'Hatch St', accent_hex: null, hero_image_url: null, gap_email_subject: null, gap_email_intro: null,
  locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' } }
const GAP = { id: 'gp1', kind: 'move_gap', status: 'completed', contact_id: 'c1', contact_email: 'aoife@x.ie', contact_name: 'Aoife Byrne', contact_phone: null,
  amount_cents: 1000, currency: 'EUR', confirmation_email_sent_at: null, race_event_id: 'e2', race_registration_id: 'r1', registration_move_id: 'mv1',
  race: RACE,
  registration: { id: 'r1', wave: { id: 'w9', start_time: '11:00:00', label: null } },
  move: { id: 'mv1', from_event: { id: 'e1', name: 'Hatch Oct 18' } } }
const PAY_URL = 'https://crm.test/event-pay/gp1'

function fakeDb({ payment = GAP, readError = null, stampRows = [{ id: 'gp1' }], stampError = null } = {}) {
  const writes = []
  const queries = []
  return {
    writes,
    queries,
    from(table) {
      const q = { table, ops: [] }
      queries.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.update = (patch) => { q.ops.push(['update', patch]); writes.push({ table, patch }); return b }
      const answer = () => {
        if (q.ops.some((o) => o[0] === 'update')) return { data: stampError ? null : stampRows, error: stampError }
        if (table === 'race_payments') return { data: readError ? null : payment, error: readError }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

const sent = () => sendTransactionalEmail.mock.calls[0][0]

beforeEach(() => {
  sendTransactionalEmail.mockClear()
  sendTransactionalEmail.mockImplementation(async () => ({ ok: true }))
  logError.mockClear()
  checkTransactionalConsent.mockClear()
  checkTransactionalConsent.mockResolvedValue({ allowed: true })
})

describe('sendRaceConfirmations — a move_gap row is not an entry', () => {
  it('skips it with kind=move_gap and sends nothing', async () => {
    const db = fakeDb()
    const r = await sendRaceConfirmations({ db, paymentId: 'gp1' })
    expect(r).toEqual({ sent: [], skipped: ['kind=move_gap'], failed: [] })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
})

describe('sendGapPaidEmail — the receipt', () => {
  it('sends the default receipt to the payer from the comms location, and stamps confirmation_email_sent_at after the send', async () => {
    const db = fakeDb()
    const r = await sendGapPaidEmail({ db, paymentId: 'gp1' })
    expect(r).toEqual({ sent: ['email'], skipped: [], failed: [] })
    const call = sent()
    expect(call.to).toBe('aoife@x.ie')
    expect(call.tag).toBe('event-gap-paid')
    expect(call.locationId).toBe('L-comms')
    expect(call.contactId).toBe('c1')
    expect(call.subject).toBe('Thanks, the €10.00 difference for Hatch Oct 25 is paid')
    expect(call.htmlBody).toContain('Hatch Oct 18')
    expect(call.htmlBody).toContain('€10.00')
    expect(call.htmlBody).not.toContain('checkin-qr')
    const stamp = db.queries.find((q) => q.table === 'race_payments' && q.ops.some((o) => o[0] === 'update'))
    expect(stamp.ops).toContainEqual(['update', { confirmation_email_sent_at: expect.any(String) }])
    expect(stamp.ops).toContainEqual(['eq', 'id', 'gp1'])
    expect(stamp.ops).toContainEqual(['is', 'confirmation_email_sent_at', null])
    expect(stamp.ops.some((o) => o[0] === 'select')).toBe(true)
  })
  it('uses the operator gap subject and intro with the gap merge tags', async () => {
    const payment = { ...GAP, race: { ...RACE, gap_email_subject: '{{difference}} for {{event_name}}', gap_email_intro: 'From {{old_event_name}}: {{difference}}.' } }
    await sendGapPaidEmail({ db: fakeDb({ payment }), paymentId: 'gp1' })
    expect(sent().subject).toBe('€10.00 for Hatch Oct 25')
    expect(sent().htmlBody).toContain('From Hatch Oct 18: €10.00.')
  })
  it('gates on ADMINISTRATIVE consent as an unrecoverable message', async () => {
    await sendGapPaidEmail({ db: fakeDb(), paymentId: 'gp1' })
    expect(checkTransactionalConsent).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1', channel: 'email', unrecoverable: true }))
  })
  it('a consent refusal skips and does not stamp', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'bounced' })
    const db = fakeDb()
    const r = await sendGapPaidEmail({ db, paymentId: 'gp1' })
    expect(r.skipped).toEqual(['email:bounced'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
  it('already sent: skips, no second email', async () => {
    const r = await sendGapPaidEmail({ db: fakeDb({ payment: { ...GAP, confirmation_email_sent_at: '2026-10-09T10:00:00Z' } }), paymentId: 'gp1' })
    expect(r.skipped).toEqual(['email:already_sent'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('refuses an entry payment (kind=entry): the entry has its own confirmation', async () => {
    const r = await sendGapPaidEmail({ db: fakeDb({ payment: { ...GAP, kind: 'entry' } }), paymentId: 'gp1' })
    expect(r.skipped).toEqual(['kind=entry'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('refuses a payment that is not completed', async () => {
    const r = await sendGapPaidEmail({ db: fakeDb({ payment: { ...GAP, status: 'pending' } }), paymentId: 'gp1' })
    expect(r.skipped).toEqual(['status=pending'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('a failed send is reported and logged, and nothing is stamped', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const db = fakeDb()
    const r = await sendGapPaidEmail({ db, paymentId: 'gp1' })
    expect(r).toEqual({ sent: [], skipped: [], failed: ['email:postmark down'] })
    expect(db.writes).toEqual([])
    expect(logError).toHaveBeenCalled()
  })
  it('a lost CAS is a duplicate, not a success', async () => {
    const r = await sendGapPaidEmail({ db: fakeDb({ stampRows: [] }), paymentId: 'gp1' })
    expect(r.sent).toEqual(['email'])
    expect(r.failed).toEqual(['email:duplicate_send'])
  })
  it('an unreadable payment fails to load, sends nothing, and logs', async () => {
    const r = await sendGapPaidEmail({ db: fakeDb({ readError: { message: 'timeout' } }), paymentId: 'gp1' })
    expect(r.failed).toEqual(['load:timeout'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })
})

describe('sendGapLinkEmail — the payment link', () => {
  it('sends the default link email with a button to pay_url', async () => {
    const db = fakeDb({ payment: { ...GAP, status: 'pending' } })
    const r = await sendGapLinkEmail({ db, paymentId: 'gp1', payUrl: PAY_URL })
    expect(r).toEqual({ sent: ['email'], skipped: [], failed: [] })
    const call = sent()
    expect(call.to).toBe('aoife@x.ie')
    expect(call.tag).toBe('event-gap-link')
    expect(call.subject).toBe('Pay the difference for Hatch Oct 25')
    expect(call.htmlBody).toContain(`href="${PAY_URL}"`)
    expect(call.htmlBody).toContain('Hatch Oct 18')
    expect(call.htmlBody).toContain('€10.00')
  })
  it('says the link is valid for 24 hours, even under operator copy', async () => {
    const payment = { ...GAP, status: 'pending', race: { ...RACE, gap_email_intro: 'Pay up.' } }
    await sendGapLinkEmail({ db: fakeDb({ payment }), paymentId: 'gp1', payUrl: PAY_URL })
    expect(sent().htmlBody).toContain('valid for 24 hours')
  })
  it('stamps nothing: staff may send the link again', async () => {
    const db = fakeDb({ payment: { ...GAP, status: 'pending' } })
    await sendGapLinkEmail({ db, paymentId: 'gp1', payUrl: PAY_URL })
    expect(db.writes).toEqual([])
  })
  it('the operator copy resolves {{pay_url}}, {{difference}} and {{old_event_name}}, and the button stays', async () => {
    const payment = { ...GAP, status: 'pending', race: { ...RACE, gap_email_subject: 'Top up {{difference}}', gap_email_intro: 'Moved from {{old_event_name}}. Pay {{difference}} at {{pay_url}}' } }
    await sendGapLinkEmail({ db: fakeDb({ payment }), paymentId: 'gp1', payUrl: PAY_URL })
    expect(sent().subject).toBe('Top up €10.00')
    expect(sent().htmlBody).toContain(`Moved from Hatch Oct 18. Pay €10.00 at ${PAY_URL}`)
    expect(sent().htmlBody).toContain(`href="${PAY_URL}"`)
  })
  it('a consent refusal skips', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'administrative_opt_out' })
    const r = await sendGapLinkEmail({ db: fakeDb({ payment: { ...GAP, status: 'pending' } }), paymentId: 'gp1', payUrl: PAY_URL })
    expect(r.skipped).toEqual(['email:administrative_opt_out'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('refuses a paid gap and an entry payment', async () => {
    expect((await sendGapLinkEmail({ db: fakeDb({ payment: GAP }), paymentId: 'gp1', payUrl: PAY_URL })).skipped).toEqual(['status=completed'])
    expect((await sendGapLinkEmail({ db: fakeDb({ payment: { ...GAP, kind: 'entry', status: 'pending' } }), paymentId: 'gp1', payUrl: PAY_URL })).skipped).toEqual(['kind=entry'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('a failed send is reported and logged', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const r = await sendGapLinkEmail({ db: fakeDb({ payment: { ...GAP, status: 'pending' } }), paymentId: 'gp1', payUrl: PAY_URL })
    expect(r.failed).toEqual(['email:postmark down'])
    expect(logError).toHaveBeenCalled()
  })
})

describe('buildGapDefaults', () => {
  const ctx = { raceName: 'B & co', raceDateLabel: 'Saturday 25 October 2026', waveLabel: '11:00', waveRowLabel: 'Wave', locationName: 'Hatch St',
    firstName: 'Aoife', differenceLabel: '€10.00', oldEventName: '<A>', payUrl: 'https://crm.test/event-pay/p1?x=1&y=2' }
  it('link: escapes the names, carries the amount and an escaped button href', () => {
    const d = buildGapDefaults(ctx, 'link')
    expect(d.subject).toBe('Pay the difference for B & co')
    expect(d.introHtml).toContain('<strong>&lt;A&gt;</strong>')
    expect(d.introHtml).toContain('<strong>B &amp; co</strong>')
    expect(d.infoRows).toContain('€10.00')
    expect(d.afterInfoHtml).toContain('href="https://crm.test/event-pay/p1?x=1&amp;y=2"')
    expect(d.memberQrs).toEqual([])
  })
  it('paid: a receipt with no button', () => {
    const d = buildGapDefaults(ctx, 'paid')
    expect(d.subject).toBe('Thanks, the €10.00 difference for B & co is paid')
    expect(d.afterInfoHtml).toBe('')
    expect(d.infoRows).toContain('Paid')
  })
})
