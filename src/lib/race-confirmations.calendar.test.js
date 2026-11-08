// CALENDAR.1 — the confirmation and moved emails carry "Add it to your
// calendar" links (the .ics route and Google), built from the event's
// session on the studio's clock; operator copy can carry them as merge tags.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => null),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://un1t.repset.ie') }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { sendTransactionalEmail } = await import('./postmark')
const { sendRegistrationMovedEmail, buildMovedDefaults, buildConfirmationDefaults } = await import('./race-confirmations.js')

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'

const LINKS = { ics_url: 'https://un1t.repset.ie/api/public/events/mob/calendar.ics?wave=w9', google_url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Mob', starts_at: '2026-07-18T09:00:00.000Z', ends_at: '2026-07-18T10:00:00.000Z' }
const CTX = { raceName: 'B', oldEventName: 'A', oldWhen: 'Sat 18 Oct · 11:00', captainFirstName: 'Aoife',
  raceDateLabel: 'Saturday 25 October 2026', waveLabel: '11:00', waveRowLabel: 'Time', locationName: 'Hatch St', isRace: false,
  teamName: 'Aoife', teamSize: 1, teamMembers: [{ name: 'Aoife', role: 'captain', is_member: true, qrSrc: 'x' }],
  amountLabel: '€25.00', memberCount: 0, nonMemberCount: 1, memberFeeLabel: null, nonMemberFeeLabel: '€25.00' }

describe('calendar line in the default footers', () => {
  it('the confirmation footer links the .ics and Google when links exist, and says nothing otherwise', () => {
    const d = buildConfirmationDefaults({ ...CTX, calendarLinks: LINKS })
    expect(d.footerHtml).toContain('Add it to your calendar')
    expect(d.footerHtml).toContain(`href="${LINKS.ics_url}"`)
    expect(d.footerHtml).toContain(`href="${LINKS.google_url.replace(/&/g, '&amp;')}"`)
    expect(buildConfirmationDefaults(CTX).footerHtml).not.toContain('calendar')
  })
  it('the moved footer carries the same line', () => {
    expect(buildMovedDefaults({ ...CTX, calendarLinks: LINKS }).footerHtml).toContain('Add it to your calendar')
    expect(buildMovedDefaults({ ...CTX, calendarLinks: LINKS, sameEvent: true }).footerHtml).toContain('Add it to your calendar')
  })
})

const MOVE = { id: 'mv1', registration_id: 'r1', notified_at: null, from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' }, from_wave: { start_time: '11:00:00', label: null } }
const RACE = { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', kind: 'workshop', race_date: '2026-10-25', location_id: 'L1', host_id: null, duration_minutes: 90,
  venue_name: 'Hatch St', venue_address: null, accent_hex: null, hero_image_url: null, moved_email_subject: null, moved_email_intro: null,
  locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1', timezone: 'Europe/Dublin' } }
const REG = { id: 'r1', status: 'confirmed', contact_id: 'c1', race_event_id: 'e2',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie', phone: '+3531' },
  wave: { id: 'w9', start_time: '11:00:00', label: null },
  teams: { id: 't2', name: 'Aoife Byrne', size: 1, team_members: [{ id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true, email: 'aoife@x.ie' }] },
  race: RACE }
function fakeDb() {
  return {
    from(table) {
      const q = { table, ops: [] }
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.update = () => { q.ops.push(['update']); return b }
      const answer = () => {
        if (table === 'registration_moves') return q.ops.some((o) => o[0] === 'update') ? { data: [{ id: 'mv1' }], error: null } : { data: MOVE, error: null }
        if (table === 'race_registrations') return { data: REG, error: null }
        if (table === 'race_payments') return { data: [], error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

beforeEach(() => { sendTransactionalEmail.mockClear() })

describe('the moved email carries the links for the NEW session', () => {
  it('links the .ics route for the target wave and a Google link with the Dublin instant in UTC', async () => {
    await sendRegistrationMovedEmail(fakeDb(), { registrationId: 'r1', moveId: 'mv1' })
    const html = sendTransactionalEmail.mock.calls[0][0].htmlBody
    expect(html).toContain('https://un1t.repset.ie/api/public/events/hatch-oct25-1100/calendar.ics?wave=w9')
    expect(html).toContain('dates=20261025T110000Z%2F20261025T123000Z') // GMT in late October, 90 minutes
  })
})
