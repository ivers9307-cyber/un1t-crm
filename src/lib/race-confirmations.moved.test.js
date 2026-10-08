import { describe, it, expect, vi, beforeEach } from 'vitest'

// Partial: event-email's merge tags need postmark's real applyMergeTags.
vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => null),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { logError } = await import('./log')
const { sendRegistrationMovedEmail, buildMovedDefaults } = await import('./race-confirmations.js')
const { verifyCheckinToken } = await import('./event-checkin-tokens.js')

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'

const MOVE = { id: 'mv1', registration_id: 'r1', notified_at: null,
  from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' }, from_wave: { start_time: '11:00:00', label: null } }
const RACE = { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', kind: 'race', race_date: '2026-10-25', location_id: 'L1', host_id: null,
  venue_name: 'Hatch St', accent_hex: null, hero_image_url: null, moved_email_subject: null, moved_email_intro: null,
  locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' } }
const REG = {
  id: 'r1', status: 'confirmed', contact_id: 'c1', race_event_id: 'e2',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie', phone: '+3531' },
  wave: { id: 'w9', start_time: '11:00:00', label: null },
  teams: { id: 't2', name: 'The Crushers', size: 2, team_members: [
    { id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true, email: 'aoife@x.ie' },
    { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false, email: null },
  ] },
  race: RACE,
}
const SOLO_REG = { ...REG, teams: { id: 't3', name: 'Aoife Byrne', size: 1, team_members: [REG.teams.team_members[0]] } }
const PAYMENT = { id: 'p1', amount_cents: 6400, currency: 'EUR', status: 'completed', contact_email: 'pay@x.ie', member_count: 1, non_member_count: 1, member_fee_cents: 2000, non_member_fee_cents: 3000 }

function fakeDb({ stampRows = [{ id: 'mv1' }], move = MOVE, reg = REG, payments = { data: [PAYMENT], error: null } } = {}) {
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
        if (table === 'registration_moves') return q.ops.some((o) => o[0] === 'update') ? { data: stampRows, error: null } : { data: move, error: null }
        if (table === 'race_registrations') return { data: reg, error: null }
        if (table === 'race_payments') return payments
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
  logError.mockClear()
  checkTransactionalConsent.mockResolvedValue({ allowed: true })
})

describe('sendRegistrationMovedEmail', () => {
  it('sends the new event details with a QR per person and stamps notified_at after the send', async () => {
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.sent).toEqual(['email'])
    const call = sent()
    expect(call.to).toBe('aoife@x.ie')
    expect(call.tag).toBe('event-moved')
    expect(call.subject).toBe('Your entry has moved to Hatch Oct 25')
    expect(call.htmlBody).toContain('Hatch Oct 18')
    expect((call.htmlBody.match(/checkin-qr\?t=/g) || []).length).toBe(2)
    expect(db.writes).toEqual([{ table: 'registration_moves', patch: expect.objectContaining({ notified_at: expect.any(String) }) }])
  })
  it('stamps with the id filter, the notified_at IS NULL check and a returning select', async () => {
    const db = fakeDb()
    await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    const stamp = db.queries.find((q) => q.table === 'registration_moves' && q.ops.some((o) => o[0] === 'update'))
    expect(stamp.ops).toContainEqual(['eq', 'id', 'mv1'])
    expect(stamp.ops).toContainEqual(['is', 'notified_at', null])
    expect(stamp.ops.some((o) => o[0] === 'select')).toBe(true)
    const pay = db.queries.find((q) => q.table === 'race_payments')
    expect(pay.ops).toContainEqual(['eq', 'race_registration_id', 'r1'])
  })
  it('uses the operator subject and intro when set', async () => {
    const race = { ...RACE, moved_email_subject: 'New date for {{event_name}}', moved_email_intro: 'You were on {{old_event_name}}.' }
    await sendRegistrationMovedEmail(fakeDb({ reg: { ...REG, race } }), { registrationId: 'r1', moveId: 'mv1' })
    expect(sent().subject).toBe('New date for Hatch Oct 25')
    expect(sent().htmlBody).toContain('You were on Hatch Oct 18.')
  })
  it('skips when consent refuses, and does not stamp', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'bounced' })
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:bounced'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
  it('skips an already-notified move', async () => {
    const r = await sendRegistrationMovedEmail(fakeDb({ move: { ...MOVE, notified_at: '2026-10-08T10:00:00Z' } }), { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:already_sent'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
})

describe('sendRegistrationMovedEmail — guards', () => {
  it('mints every QR against the TARGET event, so the old tickets stop working', async () => {
    await sendRegistrationMovedEmail(fakeDb(), { registrationId: 'r1', moveId: 'mv1' })
    const tokens = [...sent().htmlBody.matchAll(/checkin-qr\?t=([^"&]+)/g)].map((m) => decodeURIComponent(m[1]))
    expect(tokens.map((t) => verifyCheckinToken(t, 'test-secret'))).toEqual([
      { eventId: 'e2', registrationId: 'r1', memberId: 'm1' },
      { eventId: 'e2', registrationId: 'r1', memberId: 'm2' },
    ])
  })
  it('reports a failed send and does not stamp notified_at', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r).toEqual({ sent: [], skipped: [], failed: ['email:postmark down'] })
    expect(db.writes).toEqual([])
  })
  it('records a lost CAS as a duplicate, not a success', async () => {
    const r = await sendRegistrationMovedEmail(fakeDb({ stampRows: [] }), { registrationId: 'r1', moveId: 'mv1' })
    expect(r.sent).toEqual(['email'])
    expect(r.failed).toEqual(['email:duplicate_send'])
  })
  it('refuses a move that belongs to another registration, sending nothing', async () => {
    const r = await sendRegistrationMovedEmail(fakeDb(), { registrationId: 'r-other', moveId: 'mv1' })
    expect(r.failed).toEqual(['load:move_not_found'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('says "Payment pending", not "Free entry", for an entry with no completed payment yet', async () => {
    const db = fakeDb({ reg: { ...REG, status: 'pending_payment' }, payments: { data: [{ ...PAYMENT, status: 'pending' }], error: null } })
    await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(sent().htmlBody).toContain('Payment pending')
    expect(sent().htmlBody).not.toContain('Free entry')
  })
  it('a failed payment read says "See your original receipt", never "Free entry", and logs it', async () => {
    const db = fakeDb({ payments: { data: null, error: { message: 'timeout' } } })
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.sent).toEqual(['email'])
    expect(sent().htmlBody).toContain('See your original receipt')
    expect(sent().htmlBody).not.toContain('Free entry')
    expect(logError).toHaveBeenCalledWith('race-confirmations', expect.stringContaining('See your original receipt'), expect.objectContaining({ moveId: 'mv1' }))
  })
  it('falls back to the payment address when the contact has none', async () => {
    const reg = { ...REG, contact: { ...REG.contact, email: null }, teams: { ...REG.teams, team_members: REG.teams.team_members.map((m) => ({ ...m, email: null })) } }
    await sendRegistrationMovedEmail(fakeDb({ reg }), { registrationId: 'r1', moveId: 'mv1' })
    expect(sent().to).toBe('pay@x.ie')
  })
  it('with no address anywhere, logs and skips no_email', async () => {
    const reg = { ...REG, contact: { ...REG.contact, email: null }, teams: { ...REG.teams, team_members: REG.teams.team_members.map((m) => ({ ...m, email: null })) } }
    const db = fakeDb({ reg, payments: { data: [{ ...PAYMENT, contact_email: null }], error: null } })
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:no_email'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('race-confirmations', 'moved email: no address for the lead contact', { registrationId: 'r1', moveId: 'mv1' })
  })
  it('a solo entry reads "your ticket", lists no team and no team size', async () => {
    await sendRegistrationMovedEmail(fakeDb({ reg: SOLO_REG }), { registrationId: 'r1', moveId: 'mv1' })
    const html = sent().htmlBody
    expect(html).toContain('Your new ticket is below')
    expect(html).not.toContain('Your team')
    expect(html).not.toContain('Team size')
    expect((html.match(/checkin-qr\?t=/g) || []).length).toBe(1)
  })
})

const CTX = { raceName: 'B', oldEventName: 'A', oldWhen: 'Sat 18 Oct · 11:00', captainFirstName: 'Aoife',
  raceDateLabel: 'Saturday 25 October 2026', waveLabel: '11:00', waveRowLabel: 'Wave', locationName: 'Hatch St', isRace: true,
  teamName: 'The Crushers', teamSize: 2,
  teamMembers: [{ name: 'Aoife', role: 'captain', is_member: true, qrSrc: 'x' }, { name: 'Dan', role: 'member', is_member: false, qrSrc: 'y' }],
  amountLabel: '€64.00', memberCount: 1, nonMemberCount: 1, memberFeeLabel: '€20.00', nonMemberFeeLabel: '€30.00' }

describe('buildMovedDefaults', () => {
  it('a team: names both events, keeps the team list and the team size row', () => {
    const d = buildMovedDefaults(CTX)
    expect(d.subject).toBe('Your entry has moved to B')
    expect(d.heading).toBe("Your team's entry has moved, Aoife.")
    expect(d.introHtml).toContain('<strong>A</strong> (Sat 18 Oct · 11:00)')
    expect(d.introHtml).toContain('<strong>B</strong>')
    expect(d.introHtml).toContain('Your new tickets are below')
    expect(d.afterInfoHtml).toContain('Your team')
    expect(d.infoRows).toContain('Team size')
    expect(d.memberQrs).toHaveLength(2)
  })
  it('a solo entry: "Your entry" / "your ticket", no team list, no team size row, still one QR', () => {
    const d = buildMovedDefaults({ ...CTX, teamName: 'Aoife', teamSize: 1, teamMembers: [CTX.teamMembers[0]] })
    expect(d.heading).toBe('Your entry has moved, Aoife.')
    expect(d.introHtml).toContain('Your new ticket is below; the old one no longer works.')
    expect(d.afterInfoHtml).toBe('')
    expect(d.infoRows).not.toContain('Team size')
    expect(d.infoRows).toContain('Total paid')
    expect(d.memberQrs).toHaveLength(1)
  })
  it('the footer speaks of a wave and race-day energy only for a race', () => {
    expect(buildMovedDefaults(CTX).footerHtml).toContain('before your wave')
    expect(buildMovedDefaults(CTX).footerHtml).toContain('race-day energy')
    const workshop = buildMovedDefaults({ ...CTX, isRace: false, waveRowLabel: 'Time' }).footerHtml
    expect(workshop).toContain('arrive 30 minutes before your start')
    expect(workshop).not.toContain('race-day')
  })
})
