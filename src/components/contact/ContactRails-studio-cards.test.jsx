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
