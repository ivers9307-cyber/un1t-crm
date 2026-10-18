// @vitest-environment jsdom
//
// UN1TWRITE.8 fix 1 — declining a refund_request card must not prefill the
// thread composer: Mia's refund_request_text already answered the customer, so a
// generic "we couldn't action that" draft (em dash and all) would overwrite what
// staff are typing. A decline of any other kind still prefills. Fictional ids only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('@/components/SequencePicker', () => ({ default: () => null }))
const { default: ApprovalActionCard } = await import('./ApprovalActionCard.jsx')

const card = (kind) => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  kind,
  status: 'pending',
  details: { reason: 'double_payment', amount_cents: 1500, currency: 'EUR' },
  decision_note: null,
})

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (url) => ({
    json: async () => (String(url).endsWith('/suggest')
      ? { success: true, suggestion: null }
      : { success: true, request: { status: 'declined' } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function decline(kind) {
  const onPrefillComposer = vi.fn()
  render(<ApprovalActionCard request={card(kind)} contactFirstName="Aoife" onPrefillComposer={onPrefillComposer} />)
  fireEvent.click(screen.getByText('Decline'))
  fireEvent.click(screen.getByText('Confirm decline'))
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/suggest'))).toBe(true))
  return onPrefillComposer
}

describe('ApprovalActionCard decline prefill', () => {
  it('declining a refund_request prefills nothing', async () => {
    const onPrefill = await decline('refund_request')
    expect(onPrefill).not.toHaveBeenCalled()
  })

  it('declining a pause still prefills the explanation draft', async () => {
    const onPrefill = await decline('pause')
    expect(onPrefill).toHaveBeenCalledOnce()
    expect(onPrefill.mock.calls[0][0]).toContain('Aoife')
  })
})
