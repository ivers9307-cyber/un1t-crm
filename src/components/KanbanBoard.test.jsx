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
  default: ({ deal, manual }) => (
    <div data-card={deal.id} data-card-manual={String(manual)}>{deal.title}</div>
  ),
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

// WAITLIST.5 — the board mode has to reach the card, not just the drag host.
// DealCard uses it to drop the Cold action, which is meaningless on a manual
// board; forgetting to forward it would leave that button showing with nothing
// in the markup to say so.
describe('KanbanBoard — the card learns the board mode', () => {
  it('forwards manual=true to every card', () => {
    const html = render({ manual: true })
    expect((html.match(/data-card-manual="true"/g) || []).length).toBe(DEALS.length)
  })

  it('forwards manual=false on a derived board', () => {
    const html = render({ manual: false })
    expect(html).not.toContain('data-card-manual="true"')
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

// HATCHPIPE.4 — the server now ships funnel and manual columns whole, so the
// board's existing rule (a "Load more" control only while loaded < total) is
// what makes the button disappear. Pin both sides of that rule.
describe('KanbanBoard — Load more shows only while cards are unloaded', () => {
  it('draws no Load more when every card of every column is loaded', () => {
    const html = render({ manual: false })
    expect(html).not.toContain('Load more')
  })

  it('draws Load more (n of total) for a column with unloaded cards', () => {
    const html = render({ view: 'dormant', stageCounts: { 's-1': 5457, 's-2': 1 } })
    expect(html).toContain('Load more (1 of 5457)')
    expect(html).not.toContain('Load more (1 of 1)')
  })
})

// HATCHCARD.2 — a un1t.online board sorts unbooked people to the top of each
// column, like a Glofox board does, reading the card's own signals.
describe('KanbanBoard — unbooked first on a un1t board (HATCHCARD.2)', () => {
  const stage = [{ id: 's-n', slug: 'new_lead', name: 'New Leads' }]
  const sig = (next) => ({ classes_attended: 0, credits_left: 3, credits_unlimited: false, next_class_at: next, last_class_days: null, last_class_warm: false, wa_state: 'never', wa_days: null, trial_kind: null, trial_ends_at: null, trial_days_left: null, trial_ended_days: null })
  const order = (html) => [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1])
  const board = (deals) => renderToStaticMarkup(<KanbanBoard initialStages={stage} initialDeals={deals} stageCounts={{ 's-n': deals.length }} locationId="l-1" />)

  it('a booked card sinks below an unbooked one, whatever order the server sent', () => {
    const deals = [
      { id: 'booked', stage_id: 's-n', title: 'A', signals: sig('2026-11-05T08:00:00Z'), contacts: { id: 'c-a' } },
      { id: 'unbooked', stage_id: 's-n', title: 'B', signals: sig(null), contacts: { id: 'c-b' } },
    ]
    expect(order(board(deals))).toEqual(['unbooked', 'booked'])
  })
  it('a card whose signals are null keeps its place among the unbooked (no booking known)', () => {
    const deals = [
      { id: 'booked', stage_id: 's-n', title: 'A', signals: sig('2026-11-05T08:00:00Z'), contacts: { id: 'c-a' } },
      { id: 'unknown', stage_id: 's-n', title: 'B', signals: null, contacts: { id: 'c-b' } },
    ]
    expect(order(board(deals))).toEqual(['unknown', 'booked'])
  })
  it('a Glofox board still sorts on contacts.next_class_at, as before', () => {
    const deals = [
      { id: 'booked', stage_id: 's-n', title: 'A', contacts: { id: 'c-a', next_class_at: '2026-11-05T08:00:00Z' } },
      { id: 'unbooked', stage_id: 's-n', title: 'B', contacts: { id: 'c-b', next_class_at: null } },
    ]
    expect(order(board(deals))).toEqual(['unbooked', 'booked'])
  })
})
