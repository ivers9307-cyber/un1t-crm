// EVENT-WAITLIST.1 — the waitlist lib: room arithmetic, join (upsert, rejoin,
// host contacts, consent), the offer round (24 h rule, expiry, email +
// WhatsApp legs, stamping after the send, one failure never stops a round)
// and the claim. Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from './event-waitlist.test-helpers'

// Partial: event-email's merge tags need postmark's real applyMergeTags.
vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', async (importOriginal) => ({ ...(await importOriginal()), checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => ({ id: 'L-comms' })),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(async () => ({ sent: true })) }))
vi.mock('./race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('./host-events', () => ({ resolveMasterLocationId: vi.fn(async () => 'L-master') }))
vi.mock('./marketing-consent', () => ({ applyFormMarketingConsent: vi.fn(async () => ({ ok: true })) }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { maybeSendBookingWhatsappConfirm } = await import('./automations/booking-whatsapp-confirm')
const { findOrCreateRaceContact } = await import('./race-contact-linking')
const { applyFormMarketingConsent } = await import('./marketing-consent')
const { logError } = await import('./log')
const {
  eventHasRoom, isOfferDue, registrationWindowOpen, joinWaitlist, runWaitlistOffers,
  claimWaitlistOnRegistration, sendWaitlistOffer, buildWaitlistJoinedEmail, WAITLIST_OFFER_TEMPLATE,
} = await import('./event-waitlist.js')
const { signWaitlistClaimToken, verifyWaitlistClaimToken } = await import('./event-waitlist-tokens.js')

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const HOUR = 3600 * 1000
const RACE = {
  id: 'e1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', kind: 'race', race_date: '2026-10-18', capacity_mode: 'teams',
  active: true, status: 'published', location_id: 'L1', host_id: null, sending_location_id: null,
  registration_opens_at: null, registration_closes_at: null, venue_name: 'Hatch St', accent_hex: null, hero_image_url: null,
  waitlist_email_subject: null, waitlist_email_intro: null,
  locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' },
  waves: [{ id: 'w1', capacity: 1 }, { id: 'w2', capacity: 1 }],
}
const ROW = { id: 'wl1', race_event_id: 'e1', location_id: 'L1', contact_id: 'c1', name: 'Ann Example', email: 'ann@example.test',
  phone: '+353870000000', headcount: 1, status: 'waiting', source: 'public', last_offered_at: null, offer_count: 0 }
const confirmed = (wave, size = 1) => ({ wave_id: wave, status: 'confirmed', team: { size } })

beforeEach(() => {
  vi.clearAllMocks()
  checkTransactionalConsent.mockResolvedValue({ allowed: true })
  maybeSendBookingWhatsappConfirm.mockResolvedValue({ sent: true })
  findOrCreateRaceContact.mockResolvedValue('c1')
})

describe('eventHasRoom (the public route arithmetic, confirmed-only)', () => {
  it('room when any wave has room, none when every capped wave is full', () => {
    expect(eventHasRoom(RACE, [confirmed('w1')])).toBe(true)
    expect(eventHasRoom(RACE, [confirmed('w1'), confirmed('w2')])).toBe(false)
  })
  it('an uncapped wave, or no waves at all, is never full', () => {
    expect(eventHasRoom({ ...RACE, waves: [{ id: 'w1', capacity: 1 }, { id: 'w3', capacity: null }] }, [confirmed('w1')])).toBe(true)
    expect(eventHasRoom({ ...RACE, waves: [] }, [])).toBe(true)
  })
  it('counts only confirmed entries', () => {
    expect(eventHasRoom(RACE, [confirmed('w1'), { wave_id: 'w2', status: 'pending_payment', team: { size: 1 } }])).toBe(true)
  })
  it('people mode counts heads: room for one more person', () => {
    const ev = { ...RACE, capacity_mode: 'people', waves: [{ id: 'w1', capacity: 4 }] }
    expect(eventHasRoom(ev, [confirmed('w1', 3)])).toBe(true)
    expect(eventHasRoom(ev, [confirmed('w1', 4)])).toBe(false)
  })
})

describe('isOfferDue and registrationWindowOpen', () => {
  it('due when never offered or offered 24 h ago; not when offered within 24 h or off the list', () => {
    expect(isOfferDue(ROW, NOW)).toBe(true)
    expect(isOfferDue({ ...ROW, status: 'offered', last_offered_at: new Date(NOW - 23 * HOUR).toISOString() }, NOW)).toBe(false)
    expect(isOfferDue({ ...ROW, status: 'offered', last_offered_at: new Date(NOW - 24 * HOUR).toISOString() }, NOW)).toBe(true)
    expect(isOfferDue({ ...ROW, status: 'removed' }, NOW)).toBe(false)
    expect(isOfferDue({ ...ROW, status: 'claimed' }, NOW)).toBe(false)
  })
  it('window: closed before opens_at and after closes_at', () => {
    expect(registrationWindowOpen(RACE, NOW)).toBe(true)
    expect(registrationWindowOpen({ ...RACE, registration_opens_at: '2026-10-10T00:00:00Z' }, NOW)).toBe(false)
    expect(registrationWindowOpen({ ...RACE, registration_closes_at: '2026-10-08T00:00:00Z' }, NOW)).toBe(false)
  })
})

describe('joinWaitlist', () => {
  function joinDb({ existing = null, insertError = null, updateError = null, host = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'event_hosts') return { data: host, error: null }
      if (q.table !== 'event_waitlist') return { data: null, error: null }
      if (q.action === 'insert') return insertError ? { data: null, error: insertError } : { data: { ...ROW, ...q.payload, id: 'wl-new' }, error: null }
      if (q.action === 'update') return updateError ? { data: null, error: updateError } : { data: { ...existing, ...q.payload }, error: null }
      return { data: existing, error: null }
    })
  }

  it('creates a waiting row keyed on the lower-cased email, links the contact, sends the joined email', async () => {
    const db = joinDb()
    const r = await joinWaitlist(db, { race: RACE, name: ' Ann Example ', email: ' Ann@Example.TEST ', phone: '0870000000', headcount: 2, consent: true, ip: '1.2.3.4' })
    expect(r.created).toBe(true)
    const ins = db.queries.find((q) => q.action === 'insert')
    expect(ins.payload).toMatchObject({ race_event_id: 'e1', location_id: 'L1', email: 'ann@example.test', name: 'Ann Example', phone: '0870000000', headcount: 2, contact_id: 'c1', marketing_consent: true, source: 'public' })
    expect(findOrCreateRaceContact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'L1', email: 'ann@example.test', insertFields: {} }))
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(db, expect.objectContaining({ contactId: 'c1', consent: true, source: 'event_form', ipAddress: '1.2.3.4' }))
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: 'ann@example.test', subject: "You're on the waitlist for Hatch Relay", tag: 'event-waitlist-joined', locationId: 'L-comms' })
  })

  it('a host event places the contact at the org master, exempt from automations (the register route\'s flags)', async () => {
    const db = joinDb({ host: { id: 'h1', organization_id: 'o1', anchor_location_id: 'L-anchor' } })
    await joinWaitlist(db, { race: { ...RACE, host_id: 'h1' }, name: 'Ann', email: 'ann@example.test' })
    expect(findOrCreateRaceContact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'L-master', insertFields: { automations_exempt: true } }))
  })

  it('no consent answer means no consent write', async () => {
    await joinWaitlist(joinDb(), { race: RACE, name: 'Ann', email: 'ann@example.test' })
    expect(applyFormMarketingConsent).not.toHaveBeenCalled()
  })

  it('a row still on the list is refreshed in place: status and offer timing kept, no second email', async () => {
    const existing = { ...ROW, status: 'offered', last_offered_at: '2026-10-09T10:00:00Z' }
    const db = joinDb({ existing })
    const r = await joinWaitlist(db, { race: RACE, name: 'Ann E', email: 'ann@example.test', headcount: 3 })
    expect(r).toMatchObject({ created: false, rejoined: false })
    const upd = db.queries.find((q) => q.action === 'update')
    expect(upd.payload).not.toHaveProperty('status')
    expect(upd.payload).not.toHaveProperty('last_offered_at')
    expect(upd.payload).toMatchObject({ name: 'Ann E', headcount: 3 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it.each(['removed', 'expired', 'claimed'])('a %s row that joins again is reset to waiting and told', async (status) => {
    const db = joinDb({ existing: { ...ROW, status, last_offered_at: '2026-10-01T10:00:00Z', removed_by_name: 'Staff' } })
    const r = await joinWaitlist(db, { race: RACE, name: 'Ann', email: 'ann@example.test' })
    expect(r.rejoined).toBe(true)
    const upd = db.queries.find((q) => q.action === 'update')
    expect(upd.payload).toMatchObject({ status: 'waiting', last_offered_at: null, removed_by_name: null })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
  })

  it('a double submit that loses the unique-key race is treated as the existing row', async () => {
    let reads = 0
    const db = fakeDb((q) => {
      if (q.action === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } }
      if (q.action === 'update') return { data: { ...ROW, ...q.payload }, error: null }
      reads += 1
      return { data: reads === 1 ? null : ROW, error: null }
    })
    const r = await joinWaitlist(db, { race: RACE, name: 'Ann', email: 'ann@example.test' })
    expect(r.row.id).toBe('wl1')
    expect(r.created).toBe(false)
  })

  it('a failed write is an error, not a success', async () => {
    const r = await joinWaitlist(joinDb({ insertError: { code: '500', message: 'boom' } }), { race: RACE, name: 'Ann', email: 'ann@example.test' })
    expect(r).toEqual({ error: 'write_failed' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('a joined email the consent gate refuses is skipped, never thrown', async () => {
    checkTransactionalConsent.mockResolvedValue({ allowed: false, reason: 'email_status=bounced' })
    const r = await joinWaitlist(joinDb(), { race: RACE, name: 'Ann', email: 'ann@example.test' })
    expect(r.created).toBe(true)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('joined email copy is plain: no em-dash, no count, no capacity', () => {
    const { subject, htmlBody } = buildWaitlistJoinedEmail({ eventName: 'Hatch Relay', dateLabel: 'Sunday 18 October', locationName: 'Hatch St', firstName: 'Ann' })
    expect(subject + htmlBody).not.toMatch(/—/)
    expect(htmlBody).toMatch(/first to book gets it/)
  })
})

describe('sendWaitlistOffer', () => {
  const offerDb = (contact = { id: 'c1', first_name: 'Ann', name: 'Ann Example', wa_phone: null, wa_status: null, contact_preferences: null }) =>
    fakeDb((q) => (q.table === 'contacts' ? { data: contact, error: null } : { data: null, error: null }))

  it('emails the claim link (administrative, unrecoverable) and WhatsApps on the offer template with name, event, link', async () => {
    const res = await sendWaitlistOffer(offerDb(), { race: RACE, row: ROW, now: NOW })
    expect(res).toEqual({ email: 'sent', whatsapp: 'sent' })
    expect(checkTransactionalConsent).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', unrecoverable: true }))
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail.subject).toBe('A spot opened up for Hatch Relay')
    expect(mail.tag).toBe('event-waitlist-offer')
    const link = mail.htmlBody.match(/href="(https:\/\/crm\.test\/event\/hatch-oct18-1100\?wl=[^"]+)"/)[1]
    const token = decodeURIComponent(new URL(link.replaceAll('&amp;', '&')).searchParams.get('wl'))
    expect(verifyWaitlistClaimToken(token, 'test-secret', { now: NOW })).toEqual({ waitlistId: 'wl1' })
    const wa = maybeSendBookingWhatsappConfirm.mock.calls[0][0]
    expect(wa).toMatchObject({ locationId: 'L1', templateName: WAITLIST_OFFER_TEMPLATE })
    expect(wa.contact.phone).toBe('+353870000000')
    expect(wa.bodyParams[0]).toBe('Ann')
    expect(wa.bodyParams[1]).toBe('Hatch Relay')
    expect(wa.bodyParams[2]).toMatch(/^https:\/\/crm\.test\/event\/hatch-oct18-1100\?wl=/)
  })

  it('operator copy is used, with {{claim_url}} merged and escaped', async () => {
    const race = { ...RACE, waitlist_email_subject: 'Room at {{event_name}}', waitlist_email_intro: 'Grab it: {{claim_url}} <b>now</b>' }
    await sendWaitlistOffer(offerDb(), { race, row: ROW, now: NOW })
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail.subject).toBe('Room at Hatch Relay')
    expect(mail.htmlBody).toMatch(/Grab it: https:\/\/crm\.test\/event\/hatch-oct18-1100\?wl=/)
    expect(mail.htmlBody).toMatch(/&lt;b&gt;now&lt;\/b&gt;/)
  })

  it('no phone: email only; WhatsApp-suppressed contact: no WhatsApp', async () => {
    expect(await sendWaitlistOffer(offerDb(), { race: RACE, row: { ...ROW, phone: null }, now: NOW })).toEqual({ email: 'sent', whatsapp: 'skipped:no_phone' })
    const res = await sendWaitlistOffer(offerDb({ id: 'c1', wa_status: 'opted_out' }), { race: RACE, row: ROW, now: NOW })
    expect(res.whatsapp).toBe('skipped:wa_status=opted_out')
    const res2 = await sendWaitlistOffer(offerDb({ id: 'c1', wa_status: null, contact_preferences: { whatsapp_administrative: false } }), { race: RACE, row: ROW, now: NOW })
    expect(res2.whatsapp).toBe('skipped:opted_out_administrative_whatsapp')
  })

  it('no approved template (or a studio with no number) is a quiet skip', async () => {
    maybeSendBookingWhatsappConfirm.mockResolvedValue({ sent: false, reason: 'template_not_found' })
    expect((await sendWaitlistOffer(offerDb(), { race: RACE, row: ROW, now: NOW })).whatsapp).toBe('skipped:template_not_found')
  })

  it('a WhatsApp leg that throws never escapes', async () => {
    maybeSendBookingWhatsappConfirm.mockRejectedValue(new Error('WhatsAppNumberMissingError'))
    const res = await sendWaitlistOffer(offerDb(), { race: RACE, row: ROW, now: NOW })
    expect(res).toEqual({ email: 'sent', whatsapp: 'failed' })
  })

  it('an email that throws is failed and logged, the WhatsApp leg still runs', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const res = await sendWaitlistOffer(offerDb(), { race: RACE, row: ROW, now: NOW })
    expect(res).toEqual({ email: 'failed', whatsapp: 'sent' })
    expect(logError).toHaveBeenCalled()
  })
})

describe('runWaitlistOffers', () => {
  function roundDb({ rows = [ROW], race = RACE, regs = [confirmed('w1'), confirmed('w2')], rowsError = null, stampError = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'event_waitlist' && q.action === 'select') return rowsError ? { data: null, error: rowsError } : { data: rows, error: null }
      if (q.table === 'event_waitlist' && q.action === 'update') {
        if (stampError) return { data: null, error: stampError }
        if (q.payload.status === 'expired') return { data: rows.map((r) => ({ id: r.id })), error: null }
        return { data: [{ id: eqOf(q, 'id') }], error: null }
      }
      if (q.table === 'race_events') return { data: race ? [race] : [], error: null }
      if (q.table === 'race_registrations') return { data: regs, error: null }
      if (q.table === 'contacts') return { data: { id: 'c1', wa_status: null }, error: null }
      return { data: null, error: null }
    })
  }
  const stamps = (db) => db.queries.filter((q) => q.table === 'event_waitlist' && q.action === 'update')

  it('offers nobody while every time is full', async () => {
    const db = roundDb()
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c).toMatchObject({ events: 0, offered: 0, no_room: 1 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('offers EVERYONE due at once when a time has room, and stamps each after its send', async () => {
    const rows = [ROW, { ...ROW, id: 'wl2', email: 'bo@example.test', phone: null }, { ...ROW, id: 'wl3', status: 'offered', last_offered_at: new Date(NOW - 2 * HOUR).toISOString() }]
    const db = roundDb({ rows, regs: [confirmed('w1')] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c).toMatchObject({ events: 1, offered: 2, skipped: 1, failed: 0 })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    const s = stamps(db)
    expect(s.map((q) => eqOf(q, 'id'))).toEqual(['wl1', 'wl2'])
    expect(s[0].payload).toEqual({ status: 'offered', last_offered_at: new Date(NOW).toISOString(), offer_count: 1 })
    // CAS: only a row still on the list is stamped.
    expect(s[0].ops).toContainEqual(['in', 'status', ['waiting', 'offered']])
  })

  it('expires the rows of an event whose date has passed and offers nothing for it', async () => {
    const db = roundDb({ race: { ...RACE, race_date: '2026-10-08' }, regs: [] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c).toMatchObject({ expired: 1, offered: 0 })
    const exp = stamps(db)[0]
    expect(exp.payload).toEqual({ status: 'expired' })
    expect(eqOf(exp, 'race_event_id')).toBe('e1')
  })

  it('an unpublished event, or one whose registration closed, offers nobody', async () => {
    for (const race of [{ ...RACE, status: 'draft' }, { ...RACE, active: false }, { ...RACE, registration_closes_at: '2026-10-08T00:00:00Z' }]) {
      sendTransactionalEmail.mockClear()
      const c = await runWaitlistOffers(roundDb({ race, regs: [] }), { now: NOW, todayStr: '2026-10-09' })
      expect(c.offered).toBe(0)
      expect(sendTransactionalEmail).not.toHaveBeenCalled()
    }
  })

  it('a row whose every send FAILED is still stamped and logged, so a dead address is retried once per 24 h, not every tick', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const rows = [{ ...ROW, phone: null }, { ...ROW, id: 'wl2', email: 'bo@example.test', phone: null }]
    const db = roundDb({ rows, regs: [] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c).toMatchObject({ offered: 1, failed: 1, skipped: 0 })
    const s = stamps(db)
    expect(s.map((q) => eqOf(q, 'id'))).toEqual(['wl1', 'wl2'])
    expect(s[0].payload).toEqual({ status: 'offered', last_offered_at: new Date(NOW).toISOString(), offer_count: 1 })
    expect(logError).toHaveBeenCalledWith('event-waitlist', expect.stringMatching(/every channel failed/), expect.objectContaining({ waitlistId: 'wl1' }))
  })

  it('without force, a row offered within 24 h is skipped (the cron rule)', async () => {
    const rows = [{ ...ROW, status: 'offered', last_offered_at: new Date(NOW - 2 * HOUR).toISOString(), offer_count: 1 }]
    const db = roundDb({ rows, regs: [] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09', eventId: 'e1' })
    expect(c).toMatchObject({ offered: 0, skipped: 1 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('force (staff / host "Offer now") ignores the 24 h rule for every row on the list', async () => {
    const rows = [
      { ...ROW, phone: null },
      { ...ROW, id: 'wl2', email: 'bo@example.test', phone: null, status: 'offered', last_offered_at: new Date(NOW - 2 * HOUR).toISOString(), offer_count: 1 },
    ]
    const db = roundDb({ rows, regs: [] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09', eventId: 'e1', force: true })
    expect(c).toMatchObject({ offered: 2, skipped: 0 })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect(stamps(db).find((q) => eqOf(q, 'id') === 'wl2').payload.offer_count).toBe(2)
  })

  it('force still never offers while every time is full', async () => {
    const c = await runWaitlistOffers(roundDb(), { now: NOW, todayStr: '2026-10-09', eventId: 'e1', force: true })
    expect(c).toMatchObject({ offered: 0, no_room: 1 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('a row the consent gate suppresses on every channel is stamped (not re-tried every 10 minutes)', async () => {
    checkTransactionalConsent.mockResolvedValue({ allowed: false, reason: 'email_status=bounced' })
    const db = roundDb({ rows: [{ ...ROW, phone: null }], regs: [] })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c).toMatchObject({ offered: 0, skipped: 1 })
    expect(stamps(db)).toHaveLength(1)
  })

  it('a failed stamp is logged loudly and never stops the round', async () => {
    const db = roundDb({ regs: [], stampError: { message: 'boom' } })
    const c = await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09' })
    expect(c.offered).toBe(1)
    expect(logError).toHaveBeenCalledWith('event-waitlist', expect.stringMatching(/could not be stamped/), expect.anything())
  })

  it('eventId limits the round to one event', async () => {
    const db = roundDb({ regs: [] })
    await runWaitlistOffers(db, { now: NOW, todayStr: '2026-10-09', eventId: 'e1' })
    const read = db.queries.find((q) => q.table === 'event_waitlist' && q.action === 'select')
    expect(eqOf(read, 'race_event_id')).toBe('e1')
  })

  it('throws when the list itself cannot be read (the cron withholds its stamp)', async () => {
    await expect(runWaitlistOffers(roundDb({ rowsError: { message: 'down' } }), { now: NOW })).rejects.toThrow(/event_waitlist read failed/)
  })

  it('nothing on any list is a clean, empty round', async () => {
    expect(await runWaitlistOffers(roundDb({ rows: [] }), { now: NOW })).toEqual({ events: 0, offered: 0, expired: 0, skipped: 0, failed: 0, no_room: 0 })
  })
})

describe('claimWaitlistOnRegistration', () => {
  const token = () => signWaitlistClaimToken({ waitlistId: 'wl1', now: NOW }, 'test-secret')
  const claimDb = (data = [{ id: 'wl1' }], error = null) => fakeDb(() => ({ data, error }))

  it('marks the row of THIS event claimed with the registration, only while it is on the list', async () => {
    const db = claimDb()
    const r = await claimWaitlistOnRegistration(db, { token: token(), registrationId: 'r9', raceEventId: 'e1', now: NOW })
    expect(r).toEqual({ claimed: true, waitlistId: 'wl1' })
    const q = db.queries[0]
    expect(q.payload).toEqual({ status: 'claimed', claimed_registration_id: 'r9' })
    expect(eqOf(q, 'id')).toBe('wl1')
    expect(eqOf(q, 'race_event_id')).toBe('e1')
    expect(q.ops).toContainEqual(['in', 'status', ['waiting', 'offered']])
  })

  it('a forged token claims nothing and writes nothing', async () => {
    const db = claimDb()
    expect(await claimWaitlistOnRegistration(db, { token: 'x.y', registrationId: 'r9', raceEventId: 'e1', now: NOW })).toEqual({ claimed: false, reason: 'invalid_token' })
    expect(db.queries).toHaveLength(0)
  })

  it('a row already off the list (or on another event) is not_on_list', async () => {
    expect((await claimWaitlistOnRegistration(claimDb([]), { token: token(), registrationId: 'r9', raceEventId: 'e1', now: NOW })).reason).toBe('not_on_list')
  })

  it('a failed write is reported, never thrown', async () => {
    const r = await claimWaitlistOnRegistration(claimDb(null, { message: 'boom' }), { token: token(), registrationId: 'r9', raceEventId: 'e1', now: NOW })
    expect(r).toMatchObject({ claimed: false, reason: 'write_failed' })
  })
})
