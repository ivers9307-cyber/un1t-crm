// WAITLIST.3 — drag-drop is gated on `manual`, and this pins BOTH halves.
//
// The gate is load-bearing, not cosmetic. FUNNEL.1 removed drag-drop from the
// derived board because the classifier overwrites a hand move on its next pass,
// so a derived board that becomes draggable again does not fail loudly — it
// quietly shows operators moves that walk back overnight. An attribute is
// exactly what static markup CAN answer honestly (unlike layout, which a
// non-browser test must never claim to measure), so assert on it.
//
// The server-side half of the same guarantee lives in
// src/app/api/deals/[id]/stage/route.test.js, which refuses a derived pipeline
// with 400 pipeline_is_derived and writes nothing.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))
// DealCard and the drawer are not under test here — stub them so this stays a
// test about the draggable host, not about the card's internals.
vi.mock('./DealCard', () => ({
  default: ({ deal }) => <div data-card={deal.id}>{deal.title}</div>,
}))
vi.mock('./contact/ContactDrawer', () => ({ default: () => null }))

const { default: KanbanBoard } = await import('./KanbanBoard.jsx')

const STAGES = [
  { id: 's-1', slug: 'waitlist_new_enquiry', name: 'New Enquiry' },
  { id: 's-2', slug: 'waitlist_no_answer', name: 'No Answer' },
]
const DEALS = [
  { id: 'd-1', stage_id: 's-1', title: 'Ada', contacts: { id: 'c-1' } },
  { id: 'd-2', stage_id: 's-2', title: 'Grace', contacts: { id: 'c-2' } },
]

const render = (props) => renderToStaticMarkup(
  <KanbanBoard initialStages={STAGES} initialDeals={DEALS} stageCounts={{ 's-1': 1, 's-2': 1 }} locationId="l-1" {...props} />,
)

describe('KanbanBoard — a DERIVED board stays read-only', () => {
  it('renders no draggable card when manual is false', () => {
    const html = render({ manual: false })
    expect(html).toContain('data-card="d-1"')
    expect(html).not.toContain('draggable="true"')
    expect(html).not.toContain('cursor-grab')
  })

  it('defaults to read-only when manual is not passed at all', () => {
    const html = render({})
    expect(html).not.toContain('draggable="true"')
  })
})

describe('KanbanBoard — a MANUAL board is draggable', () => {
  it('wraps every card in a draggable host', () => {
    const html = render({ manual: true })
    expect((html.match(/draggable="true"/g) || []).length).toBe(DEALS.length)
    expect(html).toContain('cursor-grab')
  })

  it('still renders the cards themselves', () => {
    const html = render({ manual: true })
    expect(html).toContain('data-card="d-1"')
    expect(html).toContain('data-card="d-2"')
  })
})

describe('KanbanBoard — waitlist columns are not fallback grey', () => {
  it('colours each waitlist stage from stageColors, not #6B7280', () => {
    const html = render({ manual: true })
    // mig 597's hexes: New Enquiry blue, No Answer amber.
    expect(html).toContain('#3B82F6')
    expect(html).toContain('#F59E0B')
    expect(html).not.toContain('#6B7280')
  })
})
