// @vitest-environment jsdom
//
// CHANNELREAD.1 — a failed numbers read used to render "No numbers
// configured … Add a number below", the Add button and the Embedded Signup
// Connect card over a live number. The server refuses a duplicate
// phone_number_id (409), so this was low severity, but the screen lied.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

describe('WhatsAppIntegrationTab — real answers are unchanged (pin)', () => {
  it('no numbers yet shows the empty state and Add', async () => {
    mockFetch(reply(200, { success: true, numbers: [] }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/No numbers configured/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add WhatsApp number/ })).toBeTruthy()
  })
})
