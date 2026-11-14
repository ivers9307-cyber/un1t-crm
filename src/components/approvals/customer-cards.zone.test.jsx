// @vitest-environment jsdom
// APPROVALSQ.3 — the four customer cards on /approvals show their stamp on the
// studio's clock, not the browser's. 2026-11-14T16:20Z is 11:20 in New York.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from './OfferPurchaseCard'
import { formatApprovalDateTime } from './format-date-time'

const AT = '2026-11-14T16:20:00Z'
const mia = { id: 'r1', kind: 'pause', contactName: 'Ann', subtitle: 's', reviewUrl: '/x', submittedAt: AT }
const trial = {
  kind: 'grant', id: 't1', title: 'Jane', subtitle: 's', meta: 'm', submittedAt: AT, amount: 39,
  why: 'w', email: 'j@x.com', phone: '1', contactId: 'c1', glofoxMemberId: 'g', attempts: 1, mayHaveLanded: false, reasons: [],
}
const corp = { id: 'p1', title: 'Sam', subtitle: 's', meta: 'm', submittedAt: AT, why: 'w', email: 's@x.com', phone: '2', contactId: 'c2', glofoxMemberId: null, un1tUserId: 'u' }
const offer = { id: 'o1', title: 'Pat', subtitle: 'x · €497', meta: 'm', submittedAt: AT, amount: 497, currency: 'EUR', reviewUrl: '/o' }

const CARDS = [
  ['AgentRequestDecideCard', AgentRequestDecideCard, mia],
  ['TrialPurchaseReviewCard', TrialPurchaseReviewCard, trial],
  ['CorpPromoClaimCard', CorpPromoClaimCard, corp],
  ['OfferPurchaseCard', OfferPurchaseCard, offer],
]

beforeEach(() => { globalThis.fetch = vi.fn() })
afterEach(cleanup)

describe('customer cards studio clock', () => {
  it.each(CARDS)('%s shows the New York wall time with timezone America/New_York', (_n, Card, item) => {
    const { container } = render(<Card item={item} timezone="America/New_York" />)
    expect(container.textContent).toContain('14 Nov 2026, 11:20')
    expect(container.textContent).not.toContain('16:20')
  })
  it.each(CARDS)('%s falls back to the platform zone with no prop', (_n, Card, item) => {
    const { container } = render(<Card item={item} />)
    expect(container.textContent).toContain('14 Nov 2026, 16:20')
  })
})

describe('formatApprovalDateTime', () => {
  it('keeps the old visible format', () => {
    expect(formatApprovalDateTime(AT, 'Europe/Dublin')).toBe(new Date(AT).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Dublin' }))
  })
  it('dashes an empty value and returns an unreadable one as given', () => {
    expect(formatApprovalDateTime(null, null)).toBe('—')
    expect(formatApprovalDateTime('not a date', null)).toBe('not a date')
  })
})
