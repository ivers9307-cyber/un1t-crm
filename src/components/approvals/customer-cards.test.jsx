// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from './OfferPurchaseCard'

const grant = {
  kind: 'grant', id: 't1', title: 'Jane Doe', subtitle: '€39 Trial · €39.00 · 14 days', meta: 'UN1T Stillorgan',
  submittedAt: '2026-11-10T10:00:00Z', amount: 39, why: 'Glofox refused the plan.', email: 'j@x.com', phone: '0851234567',
  contactId: 'c1', glofoxMemberId: 'gm-77', attempts: 3, mayHaveLanded: true, reasons: [],
}
const help = { ...grant, kind: 'help', reasons: ['Past trial on record'], mayHaveLanded: false }
const corp = {
  id: 'p1', title: 'Sam Roe', subtitle: 'Corporate promo · acme', meta: 'UN1T Hatch Street',
  submittedAt: '2026-11-10T10:00:00Z', why: 'Credits could not be added.', email: 's@x.com', phone: '0867654321',
  contactId: 'c2', glofoxMemberId: null, un1tUserId: 'u-88',
}
const offer = {
  id: 'o1', title: 'Pat Lee', subtitle: '3 Month Membership · €497', meta: 'UN1T Stillorgan',
  submittedAt: '2026-11-10T10:00:00Z', amount: 497, currency: 'EUR', reviewUrl: '/offer-sales?focus=o1',
}

let fetchMock
function reply(body, ok = true, status = 200) {
  fetchMock.mockResolvedValue({ ok, status, json: async () => body })
}
beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock })
afterEach(cleanup)

describe('customer cards', () => {
  it('trial grant card shows Retry grant, Mark granted in Glofox, Mark granted, no confirmation email, in that order', () => {
    render(<TrialPurchaseReviewCard item={grant} />)
    const labels = screen.getAllByRole('button').map((b) => b.textContent.trim())
    expect(labels).toEqual(['Retry grant', 'Mark granted in Glofox', 'Mark granted, no confirmation email'])
  })

  it('Mark granted, no email posts { action:"resolve", notify:false } and shows "Marked granted. The confirmation email was not sent. Any welcome sequence still runs."', async () => {
    reply({ success: true, data: { status: 'granted', emailed: false } })
    const onDecided = vi.fn()
    render(<TrialPurchaseReviewCard item={grant} onDecided={onDecided} />)
    fireEvent.click(screen.getByText('Mark granted, no confirmation email'))
    await waitFor(() => expect(screen.getByText('Marked granted. The confirmation email was not sent. Any welcome sequence still runs.')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/trial-purchases/t1/review')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'resolve', notify: false })
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('an already-granted answer shows "Already granted." for both resolve buttons', async () => {
    for (const label of ['Mark granted in Glofox', 'Mark granted, no confirmation email']) {
      reply({ success: true, data: { already: true, status: 'granted' } })
      const { unmount } = render(<TrialPurchaseReviewCard item={grant} />)
      fireEvent.click(screen.getByText(label))
      await waitFor(() => expect(screen.getByText('Already granted.')).toBeTruthy())
      expect(document.body.textContent).not.toContain('confirmation email was not sent')
      expect(document.body.textContent).not.toContain('emailed')
      unmount()
    }
  })

  it('Mark granted in Glofox still posts only { action:"resolve" }', async () => {
    reply({ success: true, data: { emailed: true } })
    render(<TrialPurchaseReviewCard item={grant} />)
    fireEvent.click(screen.getByText('Mark granted in Glofox'))
    await waitFor(() => expect(screen.getByText('Marked granted. The buyer has been emailed.')).toBeTruthy())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'resolve' })
  })

  it('a double click on Mark granted, no confirmation email sends one request', async () => {
    reply({ success: true, data: { emailed: false } })
    render(<TrialPurchaseReviewCard item={grant} />)
    const b = screen.getByText('Mark granted, no confirmation email')
    fireEvent.click(b)
    fireEvent.click(b)
    await waitFor(() => expect(screen.getByText('Marked granted. The confirmation email was not sent. Any welcome sequence still runs.')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('every button is disabled while a request is in flight', async () => {
    let release
    fetchMock.mockReturnValue(new Promise((res) => { release = res }))
    render(<TrialPurchaseReviewCard item={grant} />)
    fireEvent.click(screen.getByText('Retry grant'))
    await waitFor(() => {
      for (const b of screen.getAllByRole('button')) expect(b.disabled).toBe(true)
    })
    release({ ok: true, status: 200, json: async () => ({ success: true }) })
    await waitFor(() => expect(screen.getByText(/Back in the queue/)).toBeTruthy())
  })

  it('trial help card shows only Mark handled', () => {
    render(<TrialPurchaseReviewCard item={help} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Mark handled'])
    expect(screen.getByText('Needs a call')).toBeTruthy()
    expect(screen.getByText('Past trial on record')).toBeTruthy()
  })

  it('corp promo card shows only Mark handled and keeps its why line and contact details', () => {
    render(<CorpPromoClaimCard item={corp} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Mark handled'])
    expect(screen.getByText('Credits could not be added.')).toBeTruthy()
    expect(screen.getByText('s@x.com')).toBeTruthy()
    expect(screen.getByText('0867654321')).toBeTruthy()
    expect(screen.getByText('Open contact').getAttribute('href')).toBe('/contacts/c2')
  })

  it('offer card posts to /api/offer-purchases/<id>/fulfil and calls onDecided once', async () => {
    reply({ success: true, data: { fulfilled: true, emailed: true } })
    const onDecided = vi.fn()
    render(<OfferPurchaseCard item={offer} onDecided={onDecided} />)
    expect(screen.getByText('OFFER SALE')).toBeTruthy()
    expect(screen.getByText('Paid, not set up')).toBeTruthy()
    expect(screen.getByText('Open offer sales').getAttribute('href')).toBe('/offer-sales?focus=o1')
    fireEvent.click(screen.getByText('Mark fulfilled (emails buyer)'))
    await waitFor(() => expect(screen.getByText('Marked fulfilled. The buyer has been emailed.')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/offer-purchases/o1/fulfil')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('offer card says plainly when the buyer email did not go', async () => {
    reply({ success: true, data: { fulfilled: true, emailed: false } })
    render(<OfferPurchaseCard item={offer} />)
    fireEvent.click(screen.getByText('Mark fulfilled (emails buyer)'))
    await waitFor(() => expect(screen.getByText(/confirmation email did not send/)).toBeTruthy())
  })

  it('a failed offer fulfil shows the error and keeps the button', async () => {
    reply({ success: false, error: 'Purchase is not paid' }, false, 409)
    const onDecided = vi.fn()
    render(<OfferPurchaseCard item={offer} onDecided={onDecided} />)
    fireEvent.click(screen.getByText('Mark fulfilled (emails buyer)'))
    await waitFor(() => expect(screen.getByText(/Purchase is not paid/)).toBeTruthy())
    expect(screen.getByText('Mark fulfilled (emails buyer)')).toBeTruthy()
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('every card keeps the facts it showed before', () => {
    const t = render(<TrialPurchaseReviewCard item={grant} />)
    for (const txt of ['Jane Doe', '€39 Trial · €39.00 · 14 days', 'UN1T Stillorgan', 'Grant failed', '€39.00',
      'Glofox refused the plan.', 'j@x.com', '0851234567', 'Glofox member gm-77']) {
      expect(screen.getByText(txt)).toBeTruthy()
    }
    expect(screen.getByText(/Paid .*3 attempts/)).toBeTruthy()
    expect(screen.getByText(/Check the member's invoices in Glofox before retrying/)).toBeTruthy()
    expect(screen.getByText('Open contact').getAttribute('href')).toBe('/contacts/c1')
    t.unmount()

    render(<CorpPromoClaimCard item={corp} />)
    for (const txt of ['Sam Roe', 'Corporate promo · acme', 'UN1T Hatch Street', 'Credits not added', 'un1t.online user u-88']) {
      expect(screen.getByText(txt)).toBeTruthy()
    }
    expect(screen.getByText(/Claimed /)).toBeTruthy()
  })
})
