// @vitest-environment jsdom
//
// CHANNELREAD.1 — a failed numbers read used to render "No numbers
// configured … Add a number below", the Add button and the Embedded Signup
// Connect card over a live number. The server refuses a duplicate
// phone_number_id (409), so this was low severity, but the screen lied.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import WhatsAppIntegrationTab from './WhatsAppIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio', settings: {} }
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

function mockFetch(numbersAnswer) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.endsWith('/whatsapp/numbers')) {
      if (numbersAnswer instanceof Error) throw numbersAnswer
      return numbersAnswer
    }
    if (u.endsWith('/whatsapp/embedded-signup')) return reply(200, { success: true, data: { configured: false } })
    return reply(200, { success: true })
  })
}
const urls = () => global.fetch.mock.calls.map(([u]) => String(u))

afterEach(() => { cleanup(); delete global.fetch })

describe('WhatsAppIntegrationTab — a failed numbers read (CHANNELREAD.1)', () => {
  it('a 500 shows Could not load + Try again, no "No numbers", no Add, no Connect card', async () => {
    mockFetch(reply(500, { success: false, error: 'boom' }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText(/Could not load this location's WhatsApp numbers just now/)).toBeTruthy()
    expect(screen.queryByText(/No numbers configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
    expect(urls().some((u) => u.endsWith('/whatsapp/embedded-signup'))).toBe(false)
  })

  it('a network failure shows the same', async () => {
    mockFetch(new TypeError('Failed to fetch'))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
  })
})

describe('WhatsAppIntegrationTab — Try again (CHANNELREAD.1)', () => {
  it('a retry that fails again stays on the note and says "Still could not load"', async () => {
    mockFetch(reply(500, { success: false, error: 'boom' }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(urls().filter((u) => u.endsWith('/whatsapp/numbers'))).toHaveLength(2)
    expect(screen.queryByText(/No numbers configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
  })
})

describe('WhatsAppIntegrationTab — real answers are unchanged (pin)', () => {
  it('no numbers yet shows the empty state and Add', async () => {
    mockFetch(reply(200, { success: true, numbers: [] }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/No numbers configured/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add WhatsApp number/ })).toBeTruthy()
  })
})

describe('WhatsAppIntegrationTab — the stored token is never shown (N8NECHO.1)', () => {
  const NUMBER = {
    id: 'n1', location_id: LOC.id, label: 'Front desk', phone_number_id: '100', business_account_id: '200',
    app_id: '300', display_phone: '+353 00 000 0000', source: 'cloud_api', token_type: 'system_user',
    connected_via: 'manual', is_default: true, is_active: true, access_token_redacted: '••••••',
    history_sync_status: null, coex_link_status: null, created_at: null, updated_at: null,
  }

  it('a stored token reads "Saved (hidden)" and the hint never promises characters', async () => {
    mockFetch(reply(200, { success: true, numbers: [NUMBER] }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByText('Front desk'))
    expect(await screen.findByText('Saved (hidden)')).toBeTruthy()
    expect(screen.queryByText(/last 6/i)).toBeNull()
    expect(screen.queryByText('••••••')).toBeNull()
    expect(screen.getByText(/never shown/i)).toBeTruthy()
  })

  it('no stored token reads "Not set"', async () => {
    mockFetch(reply(200, { success: true, numbers: [{ ...NUMBER, access_token_redacted: null }] }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByText('Front desk'))
    expect(await screen.findByText('Not set')).toBeTruthy()
    expect(screen.queryByText('Saved (hidden)')).toBeNull()
    // The hint must not claim a token is stored when none is.
    expect(screen.queryByText(/token is stored/i)).toBeNull()
    expect(screen.getByText(/No token is saved/i)).toBeTruthy()
  })
})

// WAROLE.1 — the two editors whose routes are now master/owner at the
// location follow `canEdit`, which LocationIntegrations computes with the same
// rule. Without it: no Save, no Add/Edit/Delete, inputs read-only, and no
// write is ever attempted. (A pin: the cards already honoured canEdit.)
describe('WhatsAppIntegrationTab — chat openers and card sets follow canEdit (WAROLE.1)', () => {
  const SET = {
    id: 'b0000000-0000-4000-8000-000000000001', name: 'Intro',
    cards: [{ image_url: 'https://example.test/a.jpg', title: 'A' }, { image_url: 'https://example.test/b.jpg', title: 'B' }],
  }
  // Both cards hydrate from the location's settings (no GET of their own).
  const withSaved = { ...LOC, settings: { conversational_automation: { enable_welcome: true, prompts: ['Book a class'] }, wa_card_sets: [SET] } }
  const mockAll = () => {
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith('/whatsapp/numbers')) return reply(200, { success: true, numbers: [] })
      if (u.endsWith('/whatsapp/embedded-signup')) return reply(200, { success: true, data: { configured: false } })
      return reply(200, { success: true })
    })
  }

  it('canEdit=false: openers read-only with no Save; card sets listed with no Add, Edit or Delete', async () => {
    mockAll()
    render(<WhatsAppIntegrationTab location={withSaved} canEdit={false} />)
    expect(await screen.findByText('Intro')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save chat openers/ })).toBeNull()
    expect(screen.getByDisplayValue('Book a class').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Add card set/ })).toBeNull()
    expect(screen.queryByTitle('Edit this card set')).toBeNull()
    expect(screen.queryByTitle('Delete this card set')).toBeNull()
    const writes = global.fetch.mock.calls.filter(([, init]) => init && init.method && init.method !== 'GET')
    expect(writes).toEqual([])
  })

  it('canEdit=true: Save, Add, Edit and Delete are offered (unchanged)', async () => {
    mockAll()
    render(<WhatsAppIntegrationTab location={withSaved} canEdit />)
    expect(await screen.findByText('Intro')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save chat openers/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add card set/ })).toBeTruthy()
    expect(screen.getByTitle('Edit this card set')).toBeTruthy()
    expect(screen.getByTitle('Delete this card set')).toBeTruthy()
  })
})
