// @vitest-environment jsdom
//
// MIAHATCH.6 — the "Payment link sent" chip on the contact header. Shows while
// a link_sent intent is live (expires_at in the future); hides for expired or
// any other status; a failed or malformed read renders nothing.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import MiaPaymentLinkChip, { livePaymentLink } from './MiaPaymentLinkChip.jsx'

const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const intent = (over = {}) => ({
  id: 'f0000000-0000-4000-8000-000000000001',
  location_id: 'a0000000-0000-4000-8000-000000000002',
  product_title: '10 class pack',
  status: 'link_sent',
  created_at: '2026-10-19T10:00:00.000Z',
  expires_at: '2026-10-19T22:00:00.000Z',
  ...over,
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const stubFetch = (impl) => vi.stubGlobal('fetch', vi.fn(impl))
const ok = (data) => () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) })

describe('livePaymentLink', () => {
  it('picks a link_sent intent whose expiry is in the future', () => {
    expect(livePaymentLink([intent()], NOW)?.id).toBe(intent().id)
  })
  it('hides expired, past-expiry and other statuses', () => {
    expect(livePaymentLink([intent({ status: 'expired' })], NOW)).toBeNull()
    expect(livePaymentLink([intent({ status: 'paid' })], NOW)).toBeNull()
    expect(livePaymentLink([intent({ status: 'booked' })], NOW)).toBeNull()
    expect(livePaymentLink([intent({ expires_at: '2026-10-19T11:59:59.000Z' })], NOW)).toBeNull()
    expect(livePaymentLink([intent({ expires_at: 'nonsense' })], NOW)).toBeNull()
  })
  it('tolerates a non-array', () => {
    expect(livePaymentLink(null, NOW)).toBeNull()
    expect(livePaymentLink({}, NOW)).toBeNull()
  })
})

describe('MiaPaymentLinkChip', () => {
  it('shows the sky chip for a live link_sent intent', async () => {
    stubFetch(ok([intent({ expires_at: new Date(Date.now() + 3600e3).toISOString() })]))
    render(<MiaPaymentLinkChip contactId="c1" />)
    const chip = await screen.findByText('Payment link sent')
    expect(chip.className).toContain('bg-sky-500/10')
    expect(chip.className).toContain('text-sky-700')
    expect(chip.getAttribute('title') || '').toContain('10 class pack')
    expect(fetch).toHaveBeenCalledWith('/api/contacts/c1/mia-purchase-intents', expect.anything())
  })

  it('renders nothing for an expired intent', async () => {
    stubFetch(ok([intent({ status: 'expired' })]))
    const { container } = render(<MiaPaymentLinkChip contactId="c1" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('Payment link sent')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the read fails', async () => {
    stubFetch(() => Promise.reject(new Error('offline')))
    const { container } = render(<MiaPaymentLinkChip contactId="c1" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  it('renders nothing on a non-ok response', async () => {
    stubFetch(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) }))
    const { container } = render(<MiaPaymentLinkChip contactId="c1" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})
