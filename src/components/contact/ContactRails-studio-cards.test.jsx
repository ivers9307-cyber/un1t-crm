// UN1TDUAL — the contact page's Events, HR devices and Marketing preferences
// cards fetch GET routes that refuse anyone who is not a member of the
// CONTACT's studio (…/events and …/marketing-preferences 404, …/devices 403).
// A crossover viewer (mig 731: the contact holds an active membership at the
// viewer's studio) opens the page, so the rails render those cards only when
// handed contactWorkGates(user, contact).canReadStudioCards, the consent
// history card's rule. The flag itself is pinned in
// src/lib/contact-page-gates-roleui2.test.js and its wiring on the page in
// tests/contact-page-work-gates.test.js.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const stub = (name) => ({ default: () => <i data-card={name} /> })
vi.mock('@/components/ContactRaceHistory', () => stub('events'))
vi.mock('@/components/ContactDevicesCard', () => stub('devices'))
vi.mock('@/components/ContactMarketingPreferencesCard', () => stub('marketing-preferences'))
vi.mock('@/components/ContactEditDeleteActions', () => stub('edit-delete'))
vi.mock('@/components/InviteToAppButton', () => stub('invite'))
vi.mock('@/components/ContactAppAccountCard', () => stub('app-account'))
vi.mock('@/components/MemberPasswordOverrideButton', () => stub('password'))
vi.mock('@/components/LinkedAccountsCard', () => stub('linked-accounts'))
vi.mock('./GlofoxProfileCard', () => ({ default: ({ mode }) => <i data-card="glofox" data-mode={mode ?? ''} /> }))
// Mirrors the real card's one rule: nothing without a studio to show.
vi.mock('./Un1tPaymentsCard', () => ({ default: ({ studios }) => (studios?.length ? <i data-card="un1t-payments" /> : null) }))

const { default: ContactNextRail } = await import('./ContactNextRail.jsx')
const { default: ContactWhoRail } = await import('./ContactWhoRail.jsx')

const CONTACT = { id: 'c0000000-0000-4000-8000-000000000001', location_id: 'b0000000-0000-4000-8000-00000000000b', name: 'A', created_at: '2026-10-01T10:00:00Z' }
const ADMIN = { canEditDevices: false, canLinkAccount: false, canPasswordOverride: false, canEdit: false, canDelete: false, canInvite: false }

const next = (props) => renderToStaticMarkup(<ContactNextRail contact={CONTACT} admin={ADMIN} {...props} />)
const who = (props) => renderToStaticMarkup(<ContactWhoRail contact={CONTACT} person={null} identityEmails={[]} identityPhones={[]} canEditPrefs={false} {...props} />)

describe('the studio-private read cards follow canReadStudioCards', () => {
  it('a crossover viewer (flag false): no Events, HR devices or Marketing preferences', () => {
    const n = next({ canReadStudioCards: false })
    const w = who({ canReadStudioCards: false })
    expect(n).not.toContain('data-card="events"')
    expect(n).not.toContain('>Events<')
    expect(n).not.toContain('data-card="devices"')
    expect(w).not.toContain('data-card="marketing-preferences"')
    // the rest of the page still renders for them
    expect(n).toContain('Open tasks')
    expect(w).toContain('data-card="glofox"')
  })

  it('no flag handed over: hidden (fails closed)', () => {
    expect(next({})).not.toContain('data-card="events"')
    expect(next({})).not.toContain('data-card="devices"')
    expect(who({})).not.toContain('data-card="marketing-preferences"')
  })

  it('a member of the contact\'s studio (flag true): all three render', () => {
    const n = next({ canReadStudioCards: true })
    expect(n).toContain('>Events<')
    expect(n).toContain('data-card="events"')
    expect(n).toContain('data-card="devices"')
    expect(who({ canReadStudioCards: true })).toContain('data-card="marketing-preferences"')
  })
})

// HATCHPIPE.2 — the un1t.online payments card.
describe('Un1tPaymentsCard placement', () => {
  // ORGCONTACTS.5 retired the memberships card (the Studios card, which renders
  // nothing without rows, stands where it was).
  it('sits between the linked-accounts card and GlofoxProfileCard', () => {
    const cards = [...who({ un1tBilling: { studios: [{ locationId: 'x' }] } }).matchAll(/data-card="([^"]+)"/g)].map((m) => m[1])
    expect(cards).toEqual(['linked-accounts', 'un1t-payments', 'glofox'])
  })

  it('Glofox-only contact renders exactly as before', () => {
    const cards = (html) => [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1])
    const BEFORE = ['linked-accounts', 'glofox']
    expect(cards(who({}))).toEqual(BEFORE)
    expect(cards(who({ un1tBilling: { studios: [] } }))).toEqual(BEFORE)
    expect(cards(who({ un1tBilling: null }))).toEqual(BEFORE)
    expect(cards(who({ canReadStudioCards: true }))).toEqual([...BEFORE, 'marketing-preferences'])
  })
})

// CARDLENS.1 — the page decides the Glofox card's mode; the rail hands it on.
describe('Glofox card mode', () => {
  it('passes glofoxMode through to the card', () => {
    expect(who({ glofoxMode: 'hidden' })).toContain('data-mode="hidden"')
    expect(who({ glofoxMode: 'linked' })).toContain('data-mode="linked"')
  })
})

// CARDLENS.2 — a person at two studios: deals, event registrations and the
// timeline say which studio each belongs to.
describe('studio tags', () => {
  const NAMES = { s: 'Stillorgan', h: 'Hatch Street' }
  it('tags each deal with its studio', () => {
    const html = next({ deals: [{ id: 'd1', title: 'Membership', location_id: 'h', pipeline_stages: { name: 'Won', color: '#000' } }], studioNames: NAMES })
    expect(html).toContain('Hatch Street')
  })
  it('no tag when the person has one studio', () => {
    const html = next({ deals: [{ id: 'd1', title: 'Membership', location_id: 'h', pipeline_stages: { name: 'Won', color: '#000' } }], studioNames: {} })
    expect(html).not.toContain('Hatch Street')
  })
  it('tags upcoming event registrations', async () => {
    const { UpcomingEventsCard } = await import('./EventRegistrationsCards.jsx')
    const html = renderToStaticMarkup(<UpcomingEventsCard bookings={[{ id: 'b1', location_id: 's', booking_date: '2026-11-02', start_time: '10:00', end_time: '11:00', status: 'confirmed' }]} studioNames={NAMES} />)
    expect(html).toContain('Stillorgan')
  })
  it('tags timeline items', async () => {
    const { default: ContactTimeline } = await import('./ContactTimeline.jsx')
    const html = renderToStaticMarkup(<ContactTimeline timeline={[{ id: 'n1', type: 'note', activityType: 'note', date: '2026-10-20T10:00:00Z', content: 'hi', location_id: 'h' }]} studioNames={NAMES} />)
    expect(html).toContain('Hatch Street')
  })
})

// CARDLENS.3 — one Person card, and the rarely used cards folded under More.
describe('trimmed rails', () => {
  const SOURCED = { ...CONTACT, lead_source: 'Meta lead form', label: 'VIP' }
  it('the left rail has one Person card and no Details card repeating the header', () => {
    const w = renderToStaticMarkup(<ContactWhoRail contact={SOURCED} person={null} identityEmails={[{ value: 'a@b.com' }]} identityPhones={[]} canEditPrefs={false} />)
    expect(w).toContain('>Person<')
    expect(w).not.toContain('>Identity<')
    expect(w).not.toContain('>Details<')
    expect(w).not.toContain('>Source<')
    expect(w).not.toContain('>Created<')
    expect(w).toContain('a@b.com')
    expect(w).toContain('VIP')
  })

  it('Events, HR straps, app account and admin sit in a closed More section', () => {
    const n = next({ canReadStudioCards: true, admin: { ...ADMIN, canEdit: true, canLinkAccount: true } })
    const more = n.slice(n.indexOf('<details'))
    expect(n).toContain('<details')
    expect(n).not.toContain('<details open')
    expect(more).toContain('>Events<')
    expect(more).toContain('data-card="devices"')
    expect(more).toContain('data-card="app-account"')
    expect(more).toContain('data-card="edit-delete"')
  })

  it('no More section when the viewer could use nothing in it', () => {
    expect(next({ canReadStudioCards: false })).not.toContain('<details')
  })
})
