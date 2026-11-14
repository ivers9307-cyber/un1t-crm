// @vitest-environment jsdom
//
// APPROVALSQ.6 — every link out of a card, for an item at another studio, is
// "Switch to <studio> and open"; at the active studio it is the plain link.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from './OfferPurchaseCard'
import TeamDecideCard from './TeamDecideCard'
import TeamLinkCard from './TeamLinkCard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

afterEach(cleanup)

const base = { submittedAt: '2026-11-10T10:00:00Z', reviewUrl: '/somewhere?focus=1' }
const ELSEWHERE = { studioId: 'studio-2', studioName: 'Hatch Street' }
const HERE = { studioId: 'studio-1', studioName: 'Stillorgan' }
const SWITCH = 'Switch to Hatch Street and open'

const cases = [
  ['Mia: Open conversation and Full history', (s) => (
    <AgentRequestDecideCard item={{ id: 'r1', kind: 'class_booking', conversationId: 'c1', channel: 'whatsapp', contactName: 'Ann', ...base, ...s }} activeStudioId="studio-1" />
  ), { switches: 2, plain: ['Open conversation', 'Full history'] }],
  ['offer: Open offer sales', (s) => (
    <OfferPurchaseCard item={{ id: 'o1', title: 'P', subtitle: 'x', amount: 5, ...base, ...s }} activeStudioId="studio-1" />
  ), { switches: 1, plain: ['Open offer sales'] }],
  ['trial: Open contact', (s) => (
    <TrialPurchaseReviewCard item={{ kind: 'grant', id: 't1', title: 'J', contactId: 'c1', ...base, ...s }} activeStudioId="studio-1" />
  ), { switches: 1, plain: ['Open contact'] }],
  ['corporate promo: Open contact', (s) => (
    <CorpPromoClaimCard item={{ id: 'p1', title: 'S', contactId: 'c1', ...base, ...s }} activeStudioId="studio-1" />
  ), { switches: 1, plain: ['Open contact'] }],
  ['team decide card: Open in Expenses', (s) => (
    <TeamDecideCard item={{ id: 'e1', title: 'Exp', ...base, ...s }} providerKey="fte_expenses" providerLabel="Expenses" activeStudioId="studio-1" />
  ), { switches: 1, plain: ['Open in Expenses'] }],
  ['team link card: Open', (s) => (
    <TeamLinkCard item={{ id: 'k1', title: 'Roster', ...base, ...s }} providerLabel="Rosters" activeStudioId="studio-1" />
  ), { switches: 1, plain: ['Open'] }],
]

describe.each(cases)('%s', (_name, make, expected) => {
  it('switches first for an item at another studio', () => {
    render(make(ELSEWHERE))
    expect(screen.getAllByRole('button', { name: SWITCH })).toHaveLength(expected.switches)
    for (const label of expected.plain) expect(screen.queryByRole('link', { name: label })).toBeNull()
  })
  it('is the plain link at the active studio', () => {
    render(make(HERE))
    expect(screen.queryByRole('button', { name: SWITCH })).toBeNull()
    for (const label of expected.plain) expect(screen.getByRole('link', { name: label })).toBeTruthy()
  })
  it('is the plain link when the item has no studio', () => {
    render(make({}))
    expect(screen.queryByRole('button', { name: /Switch/ })).toBeNull()
    for (const label of expected.plain) expect(screen.getByRole('link', { name: label })).toBeTruthy()
  })
})
