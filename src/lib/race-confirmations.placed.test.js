// FINDTEAM.5 — the "you're on a team" email (sendPlacedEmail / buildPlacedDefaults).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Partial: event-email's merge tags need postmark's real applyMergeTags.
vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => null),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.test') }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
// The real resolver, spied, so the race-like object it receives can be read.
vi.mock('./event-email', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, resolveEventEmail: vi.fn(real.resolveEventEmail) }
})

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { resolveEventEmail } = await import('./event-email')
const { logError } = await import('./log')
const { sendPlacedEmail, buildPlacedDefaults } = await import('./race-confirmations.js')

const RACE = {
  id: 'e1', name: 'Hatch Hyrox', slug: 'hatch-hyrox', kind: 'race', race_date: '2026-11-07', location_id: 'L1', host_id: null,
  sending_location_id: null, venue_name: 'Hatch St', accent_hex: null, hero_image_url: null, find_team: null,
  locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' },
}
const REG = {
  id: 'r-solo', status: 'placed', contact_id: 'c1', race_event_id: 'e1', placed_into_registration_id: 'r-team',
  contact: { id: 'c1', first_name: 'Sarah', last_name: 'Byrne', email: 'sarah@x.ie', phone: '+3531' },
  teams: { id: 't-solo', team_members: [{ id: 'm1', name: 'Sarah Byrne', role: 'captain', email: 'sarah@x.ie' }] },
  placed_into: { id: 'r-team', wave: { start_time: '09:30:00', label: null }, teams: { name: 'The Crushers' } },
  race: RACE,
}

function fakeDb(reg = REG, error = null) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, ops: [] }
      queries.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      const answer = () => (table === 'race_registrations' ? { data: error ? null : reg, error } : { data: null, error: null })
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
  resolveEventEmail.mockClear()
  logError.mockClear()
  checkTransactionalConsent.mockResolvedValue({ allowed: true })
})

describe('buildPlacedDefaults', () => {
  const ctx = {
    raceName: 'Hatch Hyrox', raceDateLabel: 'Saturday 7 November 2026', waveLabel: '09:30', waveRowLabel: 'Wave', isRace: true,
    locationName: 'Hatch St', teamName: 'The Crushers', firstName: 'Sarah', brand: 'UN1T',
    placedSubject: "You're on a team for {{event_name}}",
    contact: { first_name: 'Sarah' },
    extras: { event_name: 'Hatch Hyrox', team_name: 'The Crushers', when: '09:30', location: 'Hatch St', first_name: 'Sarah' },
  }
  it('renders the subject merge tags and names the team and the wave', () => {
    const d = buildPlacedDefaults(ctx)
    expect(d.subject).toBe("You're on a team for Hatch Hyrox")
    expect(d.heading).toBe("You're on a team, Sarah.")
    expect(d.introHtml).toContain('The Crushers')
    expect(d.introHtml).toContain('Hatch Hyrox')
    expect(d.infoRows).toContain('09:30')
    expect(d.infoRows).toContain('The Crushers')
    expect(d.memberQrs).toEqual([])
    expect(d.footerHtml).toMatch(/What's next:<\/strong> arrive 10-15 minutes before your wave/)
    expect(d.brand).toBe('UN1T')
  })
  it('escapes a hostile team name', () => {
    const d = buildPlacedDefaults({ ...ctx, teamName: '<b>x</b>' })
    expect(d.introHtml).not.toContain('<b>x</b>')
    expect(d.introHtml).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('sendPlacedEmail', () => {
  it('sends the default placed copy with {{team_name}} and {{when}} rendered', async () => {
    const r = await sendPlacedEmail({ db: fakeDb(), registrationId: 'r-solo' })
    expect(r).toEqual({ sent: ['email'], skipped: [], failed: [] })
    expect(sent().to).toBe('sarah@x.ie')
    expect(sent().tag).toBe('event-placed')
    expect(sent().subject).toBe("You're on a team for Hatch Hyrox")
    expect(sent().htmlBody).toContain("Good news, Sarah: you&#39;ve been placed with team The Crushers in the 09:30 wave.")
    expect(sent().htmlBody).not.toMatch(/\{\{/)
  })
  it('hands resolveEventEmail kind placed and a race carrying the find_team copy', async () => {
    const race = { ...RACE, find_team: { placed_subject: 'Placed for {{event_name}}', placed_intro: 'Hi {{first_name}}, team {{team_name}} at {{when}}.' } }
    await sendPlacedEmail({ db: fakeDb({ ...REG, race }), registrationId: 'r-solo' })
    const args = resolveEventEmail.mock.calls[0][0]
    expect(args.kind).toBe('placed')
    expect(args.race.placed_email_subject).toBe('Placed for {{event_name}}')
    expect(args.race.placed_email_intro).toBe('Hi {{first_name}}, team {{team_name}} at {{when}}.')
    expect(args.race.placed_email_template_id).toBeUndefined()
    expect(args.extras).toMatchObject({ event_name: 'Hatch Hyrox', team_name: 'The Crushers', when: '09:30', location: 'Hatch St', first_name: 'Sarah' })
    expect(sent().subject).toBe('Placed for Hatch Hyrox')
    expect(sent().htmlBody).toContain('Hi Sarah, team The Crushers at 09:30.')
  })
  it('falls back to the race date when the team has no wave', async () => {
    await sendPlacedEmail({ db: fakeDb({ ...REG, placed_into: { ...REG.placed_into, wave: null } }), registrationId: 'r-solo' })
    expect(resolveEventEmail.mock.calls[0][0].extras.when).toMatch(/2026/)
  })
  it('reads the solo row with the placed team and the event copy', async () => {
    const db = fakeDb()
    await sendPlacedEmail({ db, registrationId: 'r-solo' })
    const q = db.queries.find((x) => x.table === 'race_registrations')
    expect(q.ops).toContainEqual(['eq', 'id', 'r-solo'])
    const cols = q.ops.find((o) => o[0] === 'select')[1]
    expect(cols).toMatch(/placed_into:placed_into_registration_id/)
    expect(cols).toMatch(/find_team/)
  })
  it.each([
    ['confirmed', { status: 'confirmed' }],
    ['no placed team', { placed_into: null }],
  ])('skips a row that is not placed (%s)', async (_l, over) => {
    const r = await sendPlacedEmail({ db: fakeDb({ ...REG, ...over }), registrationId: 'r-solo' })
    expect(r).toEqual({ sent: [], skipped: ['not_placed'], failed: [] })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('skips when consent refuses', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'bounced' })
    const r = await sendPlacedEmail({ db: fakeDb(), registrationId: 'r-solo' })
    expect(r.skipped).toEqual(['email:bounced'])
    expect(checkTransactionalConsent.mock.calls[0][0]).toMatchObject({ contactId: 'c1', channel: 'email', unrecoverable: true })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('skips with no address', async () => {
    const reg = { ...REG, contact: { ...REG.contact, email: null }, teams: { id: 't', team_members: [{ id: 'm1', name: 'S', role: 'captain', email: null }] } }
    const r = await sendPlacedEmail({ db: fakeDb(reg), registrationId: 'r-solo' })
    expect(r.skipped).toEqual(['email:no_email'])
  })
  it('reports an unreadable row, logged, without throwing', async () => {
    const r = await sendPlacedEmail({ db: fakeDb(null, { message: 'boom' }), registrationId: 'r-solo' })
    expect(r.failed).toEqual(['load:boom'])
    expect(logError).toHaveBeenCalled()
  })
  it('reports a failed send without throwing', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const r = await sendPlacedEmail({ db: fakeDb(), registrationId: 'r-solo' })
    expect(r).toEqual({ sent: [], skipped: [], failed: ['email:postmark down'] })
    expect(logError).toHaveBeenCalled()
  })
})
