// @vitest-environment jsdom
//
// HYGREL.1 — the card used to say "Email marketing: ON" about contacts that no
// send would ever reach.
//
// Consent (contact_preferences.email_marketing) is one gate. contacts.
// email_status (reputation) and contacts.email_suppressed_at (the 90-day
// hygiene call, mig 395) are two more, applied independently in
// buildAudienceQuery. This card only ever rendered the first, and the API
// behind it only ever returned the first, so on 2026-08-12 there were 1,128
// contacts whose record told an operator they were being emailed while nothing
// had gone out to them since 05:15 that morning.
//
// Pinned here: the banner appears when a gate is closed, names WHICH gate, and
// stays away when nothing is wrong — a card that warns on every contact is a
// card operators learn to scroll past.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

import ContactMarketingPreferencesCard from './ContactMarketingPreferencesCard.jsx'

const PREFS = {
  email_marketing: true,
  sms_marketing: true,
  whatsapp_marketing: true,
  email_administrative: true,
  sms_administrative: true,
  whatsapp_administrative: true,
  updated_at: null,
}

function mockLoad(deliverability, prefs = PREFS) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, preferences: prefs, deliverability }),
  })))
}

const CARD = () => <ContactMarketingPreferencesCard contactId="c1" canEdit />

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactMarketingPreferencesCard — the suppressed state is on screen', () => {
  it('says marketing is on but nothing is being sent, and since when', async () => {
    mockLoad({
      email_status: 'active',
      email_suppressed_at: '2026-08-12T05:15:00.000Z',
      email_hygiene_released_at: null,
    })
    render(CARD())

    expect(await screen.findByText(/marketing email is on, but nothing is being sent/i)).toBeTruthy()
    expect(screen.getByText(/held back for list hygiene/i)).toBeTruthy()
    expect(screen.getByText(/held back since 12 Aug 2026/i)).toBeTruthy()
    // The operator needs to be told the transactional half still works, or the
    // banner reads as "this contact hears nothing at all".
    expect(screen.getByText(/transactional email such as booking confirmations still goes out/i)).toBeTruthy()
  })

  it('points at the surface that can actually undo it, and offers no control of its own', async () => {
    mockLoad({ email_status: null, email_suppressed_at: '2026-08-12T05:15:00.000Z', email_hygiene_released_at: null })
    render(CARD())

    expect(await screen.findByText(/release them from communications, list health/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /release/i })).toBeNull()
  })

  it('names a bounced address as the harder failure, not as list hygiene', async () => {
    mockLoad({ email_status: 'bounced', email_suppressed_at: '2026-08-12T05:15:00.000Z', email_hygiene_released_at: null })
    render(CARD())

    expect(await screen.findByText(/this address is not receiving email/i)).toBeTruthy()
    // Reputation gates administrative mail too, which hygiene does not — so
    // the two must never be described with the same sentence.
    expect(screen.getByText(/marketing and transactional alike/i)).toBeTruthy()
    expect(screen.queryByText(/marketing email is on, but nothing is being sent/i)).toBeNull()
  })

  it('distinguishes a spam complaint from a bounce', async () => {
    mockLoad({ email_status: 'complained', email_suppressed_at: null, email_hygiene_released_at: null })
    render(CARD())
    expect(await screen.findByText(/reported a send as spam/i)).toBeTruthy()
  })

  it('shows a previous release, so a repeat suppression does not read as a failed release', async () => {
    mockLoad({
      email_status: 'active',
      email_suppressed_at: '2026-08-12T05:15:00.000Z',
      email_hygiene_released_at: '2026-08-01T09:00:00.000Z',
    })
    render(CARD())
    expect(await screen.findByText(/previously released on 01 Aug 2026/i)).toBeTruthy()
  })

  it('stays silent when the contact is genuinely mailable', async () => {
    mockLoad({ email_status: 'active', email_suppressed_at: null, email_hygiene_released_at: null })
    render(CARD())

    await screen.findByText('Marketing preferences')
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull())
    expect(screen.queryByText(/nothing is being sent/i)).toBeNull()
    expect(screen.queryByText(/not receiving email/i)).toBeNull()
  })

  it('says nothing rather than guessing when the API returns no deliverability block', async () => {
    // An older deploy of the API, or a partial response. Absence of evidence is
    // not a clean bill of health, but it is not a warning either.
    mockLoad(undefined)
    render(CARD())
    await screen.findByText('Marketing preferences')
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull())
    expect(screen.queryByText(/nothing is being sent/i)).toBeNull()
  })

  it('drops the hygiene banner while consent is off — the suppression is moot then', async () => {
    mockLoad({ email_status: 'active', email_suppressed_at: '2026-08-12T05:15:00.000Z', email_hygiene_released_at: null })
    render(CARD())

    expect(await screen.findByText(/nothing is being sent/i)).toBeTruthy()
    const [emailToggle] = screen.getAllByRole('button', { pressed: true })
    fireEvent.click(emailToggle)
    await waitFor(() => expect(screen.queryByText(/nothing is being sent/i)).toBeNull())
  })
})
