import { describe, it, expect, vi, beforeEach } from 'vitest'

// Partial: event-email's merge tags need postmark's real applyMergeTags.
vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => null),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { sendRegistrationMovedEmail, buildMovedDefaults } = await import('./race-confirmations.js')
const { verifyCheckinToken } = await import('./event-checkin-tokens.js')

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'

const MOVE = { id: 'mv1', registration_id: 'r1', notified_at: null, price_gap_cents: 1000,
  from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' }, from_wave: { start_time: '11:00:00', label: null } }
const REG = {
  id: 'r1', status: 'confirmed', contact_id: 'c1', race_event_id: 'e2',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie', phone: '+3531' },
  wave: { id: 'w9', start_time: '11:00:00', label: null },
  teams: { id: 't2', name: 'The Crushers', size: 2, team_members: [{ id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true }, { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false }] },
  race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', kind: 'race', race_date: '2026-10-25', location_id: 'L1', host_id: null,
    venue_name: 'Hatch St', accent_hex: null, hero_image_url: null, moved_email_subject: null, moved_email_intro: null,
    locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' } },
}
const PAYMENT = { id: 'p1', amount_cents: 6400, currency: 'EUR', status: 'completed', member_count: 1, non_member_count: 1, member_fee_cents: 2000, non_member_fee_cents: 3000 }

function fakeDb({ stampRows = [{ id: 'mv1' }] } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const q = { table, ops: [] }
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.update = (patch) => { writes.push({ table, patch }); return b }
      const answer = () => {
        if (table === 'registration_moves') return q.ops.some((o) => o[0] === 'is') ? { data: stampRows, error: null } : { data: MOVE, error: null }
        if (table === 'race_registrations') return { data: REG, error: null }
        if (table === 'race_payments') return { data: [PAYMENT], error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

beforeEach(() => { sendTransactionalEmail.mockClear(); checkTransactionalConsent.mockResolvedValue({ allowed: true }) })

describe('sendRegistrationMovedEmail', () => {
  it('sends the new event details with a QR per person and stamps notified_at after the send', async () => {
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.sent).toEqual(['email'])
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.to).toBe('aoife@x.ie')
    expect(call.tag).toBe('event-moved')
    expect(call.subject).toBe('Your entry has moved to Hatch Oct 25')
    expect(call.htmlBody).toContain('Hatch Oct 18')
    expect(call.htmlBody).toContain('checkin-qr?t=')
    expect((call.htmlBody.match(/checkin-qr\?t=/g) || []).length).toBe(2)
    expect(db.writes).toEqual([{ table: 'registration_moves', patch: expect.objectContaining({ notified_at: expect.any(String) }) }])
  })
  it('uses the operator subject and intro when set', async () => {
    const db = fakeDb()
    REG.race.moved_email_subject = 'New date for {{event_name}}'
    REG.race.moved_email_intro = 'You were on {{old_event_name}}.'
    try {
      await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
      const call = sendTransactionalEmail.mock.calls[0][0]
      expect(call.subject).toBe('New date for Hatch Oct 25')
      expect(call.htmlBody).toContain('You were on Hatch Oct 18.')
    } finally { REG.race.moved_email_subject = null; REG.race.moved_email_intro = null }
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
    const db = fakeDb()
    const notified = { ...MOVE, notified_at: '2026-10-08T10:00:00Z' }
    db.from = ((orig) => (table) => { const b = orig(table); if (table === 'registration_moves') { b.maybeSingle = async () => ({ data: notified, error: null }) } return b })(db.from)
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:already_sent'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
})

describe('sendRegistrationMovedEmail — guards', () => {
  it('mints every QR against the TARGET event, so the old tickets stop working', async () => {
    await sendRegistrationMovedEmail(fakeDb(), { registrationId: 'r1', moveId: 'mv1' })
    const html = sendTransactionalEmail.mock.calls[0][0].htmlBody
    const tokens = [...html.matchAll(/checkin-qr\?t=([^"&]+)/g)].map((m) => decodeURIComponent(m[1]))
    const claims = tokens.map((t) => verifyCheckinToken(t, 'test-secret'))
    expect(claims).toEqual([
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
    const db = fakeDb()
    db.from = ((orig) => (table) => {
      const b = orig(table)
      if (table === 'race_registrations') b.maybeSingle = async () => ({ data: { ...REG, status: 'pending_payment' }, error: null })
      if (table === 'race_payments') b.then = (res, rej) => Promise.resolve({ data: [{ ...PAYMENT, status: 'pending' }], error: null }).then(res, rej)
      return b
    })(db.from)
    await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    const html = sendTransactionalEmail.mock.calls[0][0].htmlBody
    expect(html).toContain('Payment pending')
    expect(html).not.toContain('Free entry')
  })
})

describe('buildMovedDefaults', () => {
  it('names both events and keeps the team list', () => {
    const d = buildMovedDefaults({ raceName: 'B', oldEventName: 'A', oldWhen: 'Sat 18 Oct · 11:00', captainFirstName: 'Aoife',
      raceDateLabel: 'Saturday 25 October 2026', waveLabel: '11:00', waveRowLabel: 'Wave', locationName: 'Hatch St',
      teamName: 'The Crushers', teamSize: 2, teamMembers: [{ name: 'Aoife', role: 'captain', is_member: true, qrSrc: 'x' }],
      amountLabel: '€64.00', memberCount: 1, nonMemberCount: 1, memberFeeLabel: '€20.00', nonMemberFeeLabel: '€30.00' })
    expect(d.subject).toBe('Your entry has moved to B')
    expect(d.introHtml).toContain('A')
    expect(d.introHtml).toContain('B')
    expect(d.memberQrs).toHaveLength(1)
  })
})
