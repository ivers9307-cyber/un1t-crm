// @vitest-environment jsdom
//
// PAGES.1 (Task 17) — the editor's preview of an offer page renders the
// page's own layout around the editable blocks: on a one_class page the coach
// video hero (its words edited in place) with the booking card inside it,
// then the expect strip; on a frosted page the offer card over the photo.
// The pinned offer region selects the offer block, has no toolbar and nothing
// inserts above it; a studio key is never written from the preview.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'

vi.mock('@/lib/funnel-track', () => ({ trackFunnelStep: vi.fn() }))
vi.mock('@/lib/meta-pixel-lead', () => ({
  newLeadEventId: () => 'lead-id', pixelUserData: () => ({}), fireBrowserLead: vi.fn(),
  fireBrowserInitiateCheckout: vi.fn(), checkoutEventIdFor: (id) => `c-${id}`,
}))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [] }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))
vi.mock('./ClassFunnelCheckout', () => ({ default: () => null }))
vi.mock('./BlockRenderers', () => ({
  default: (p) => <div data-testid={`block-${p.block.id}`}>{p.block.type}</div>,
  SiteHeader: () => null,
  SiteFooter: () => null,
}))

import EditModeOverlay from './EditModeOverlay.jsx'
import PaidTrialFunnel from './PaidTrialFunnel'

// The booking card stand-in: shows the copy it was handed and offers the
// overlay's copy hook to the test.
const renderFunnel = vi.fn((props) => (
  <div data-testid="funnel">
    <span data-testid="pick-title">{props.copy?.pick_title}</span>
    <button type="button">Book Mon 07:00</button>
  </div>
))
function FakeFunnel(props) {
  return renderFunnel(props)
}
const funnelSeen = { get props() { return renderFunnel.mock.calls.at(-1)?.[0] ?? null } }

const CF = {
  id: 'cf', type: 'campaign_funnel', eyebrow: 'The 50+ Club', heading: 'A free trial of The 50+ Club', subhead: 'Coach-led strength.',
  video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', pick_title: 'Pick your first morning',
  expect_eyebrow: 'What to expect', expect_heading: 'Built for where you are now',
  expect_cards: [{ title: 'A coach beside you', body: 'Every movement shown.' }, { title: 'Strength', body: 'Bones.' }],
}
const STATS = { id: 's1', type: 'stats', items: [] }
const HERO = { id: 'h1', type: 'hero', image_url: 'https://x/hero.jpg' }

const oneClassLayout = () => ({
  kind: 'one_class',
  anchor: 'book',
  heroImageUrl: null,
  offerBlockId: 'cf',
  offer: <FakeFunnel copy={{ pick_title: 'Pick your first morning', consent_label: 'Keep me posted by UN1T.' }} publicPath="stillorgan" />,
  hero: { videoUrl: 'https://x/v.mp4', posterUrl: 'https://x/p.jpg', soundLabel: 'Tap for sound', eyebrow: CF.eyebrow, heading: CF.heading, subhead: CF.subhead },
  expect: { eyebrow: CF.expect_eyebrow, heading: CF.expect_heading, cards: CF.expect_cards },
  scrollCueLabel: null,
  cta: { href: '#book', label: 'Book a free class' },
})

let posted
let parentWin
beforeEach(() => {
  posted = []
  renderFunnel.mockClear()
  parentWin = { postMessage: vi.fn((m) => posted.push(m)) }
  Object.defineProperty(window, 'parent', { value: parentWin, configurable: true })
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
})

const sent = (type) => posted.filter((m) => m.type === type)

describe('EditModeOverlay on an offer layout (PAGES.1)', () => {
  it('clicking the one_class hero selects the offer block and the headline is editable in place', () => {
    const { container } = render(<EditModeOverlay initialBlocks={[CF, STATS]} offerLayout={oneClassLayout()} />)

    // The layout: the coach video, the card inside the hero, the expect strip, then the blocks.
    expect(container.querySelector('video').getAttribute('src')).toBe('https://x/v.mp4')
    expect(screen.getByTestId('funnel')).toBeTruthy()
    expect(screen.getByTestId('block-s1')).toBeTruthy()
    // The pinned offer block is the region, never a block of the list.
    expect(screen.queryByTestId('block-cf')).toBeNull()

    // Clicking the hero's surface selects the offer block.
    const region = container.querySelector('[data-pinned-offer]')
    fireEvent.click(region.querySelector('section'))
    expect(sent('block-clicked')).toEqual([{ namespace: 'lp-editor', type: 'block-clicked', blockId: 'cf' }])
    expect(region.className).toContain('outline-blue-500')

    // The booking card stays live: a click on its button selects nothing.
    posted.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 07:00' }))
    expect(sent('block-clicked')).toEqual([])

    // The headline, eyebrow, subhead and the expect copy are edited in place.
    const heading = screen.getAllByRole('textbox').find((el) => el.textContent === CF.heading)
    expect(heading.closest('h1')).toBeTruthy()
    heading.textContent = 'Strong at 60'
    fireEvent.input(heading)
    expect(sent('edit-field')).toContainEqual({ namespace: 'lp-editor', type: 'edit-field', blockId: 'cf', path: ['heading'], value: 'Strong at 60' })
    expect(sent('block-clicked')).toEqual([])

    const card = screen.getAllByRole('textbox').find((el) => el.textContent === 'A coach beside you')
    card.textContent = 'Your coach'
    fireEvent.input(card)
    expect(sent('edit-field')).toContainEqual({ namespace: 'lp-editor', type: 'edit-field', blockId: 'cf', path: ['expect_cards', 0, 'title'], value: 'Your coach' })
    const expectHeading = screen.getAllByRole('textbox').find((el) => el.textContent === CF.expect_heading)
    expectHeading.textContent = 'Built for you'
    fireEvent.input(expectHeading)
    expect(sent('edit-field')).toContainEqual({ namespace: 'lp-editor', type: 'edit-field', blockId: 'cf', path: ['expect_heading'], value: 'Built for you' })
    for (const text of [CF.eyebrow, CF.subhead, 'Every movement shown.', CF.expect_eyebrow]) {
      expect(screen.getAllByRole('textbox').some((el) => el.textContent === text), text).toBe(true)
    }
  })

  it('the booking card gets the copy hook for its four words and the live copy; studio keys are refused', () => {
    render(<EditModeOverlay initialBlocks={[CF, STATS]} offerLayout={oneClassLayout()} />)
    expect(screen.getByTestId('pick-title').textContent).toBe('Pick your first morning')
    // The server's consent wording stays (the block names none).
    expect(funnelSeen.props.copy.consent_label).toBe('Keep me posted by UN1T.')
    expect(funnelSeen.props.publicPath).toBe('stillorgan')
    expect(typeof funnelSeen.props.onEditCopy).toBe('function')

    act(() => { funnelSeen.props.onEditCopy('pick_title', 'Choose a morning') })
    expect(sent('edit-field')).toEqual([{ namespace: 'lp-editor', type: 'edit-field', blockId: 'cf', path: ['pick_title'], value: 'Choose a morning' }])

    posted.length = 0
    act(() => {
      for (const key of ['class_keywords', 'trial_plan_code', 'trial_membership_id', 'tag', 'lead_source', 'event_source_url', 'campaign', 'show_sections', 'expect_eyebrow']) {
        funnelSeen.props.onEditCopy(key, 'x')
      }
    })
    // Only the four card words go through the card's hook, and never a studio key.
    expect(sent('edit-field')).toEqual([])
  })

  it('the hero tracks the editor: a state push re-renders the live copy', () => {
    render(<EditModeOverlay initialBlocks={[CF, STATS]} offerLayout={oneClassLayout()} />)
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { namespace: 'lp-editor', type: 'state', blocks: [{ ...CF, heading: 'Pushed heading', pick_title: 'Pushed pick' }, STATS] },
      }))
    })
    expect(screen.getAllByRole('textbox').some((el) => el.textContent === 'Pushed heading')).toBe(true)
    expect(screen.getByTestId('pick-title').textContent).toBe('Pushed pick')
  })

  it('the pinned region has no toolbar and the first insert gap adds at index 1', () => {
    render(<EditModeOverlay initialBlocks={[CF, STATS]} offerLayout={oneClassLayout()} />)
    expect(screen.queryByTitle(/Delete Campaign funnel/)).toBeNull()
    expect(screen.queryByTitle(/Move Campaign funnel/)).toBeNull()
    expect(screen.getByTitle('Delete Stats')).toBeTruthy()
    const gaps = screen.getAllByRole('button', { name: /Add section here/ })
    // One gap under the pinned region, one after the stats block.
    expect(gaps).toHaveLength(2)
    fireEvent.click(gaps[0])
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getAllByRole('button')[0])
    expect(sent('add-block')[0]).toMatchObject({ atIndex: 1 })
  })

  it('the frosted card renders the trial card as preview (disabled), never a live POST', () => {
    const view = {
      key: 'stillorgan', label: 'Stillorgan', publicPath: 'stillorgan', sellable: true,
      block: { heading: 'The 14 Day Reset', cta_label: 'Start my trial', consent_label: 'Keep me posted.' },
      priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'The 14 Day Reset',
    }
    const layout = {
      kind: 'frosted', anchor: 'trial', heroImageUrl: 'https://x/backdrop.jpg', offerBlockId: 'pt1',
      offer: <PaidTrialFunnel studios={[view]} initialStudio="stillorgan" returnPath="/trial" page="trial" preview />,
      scrollCueLabel: 'Learn more', cta: { href: '#trial', label: 'Start my trial' },
    }
    const PT = { id: 'pt1', type: 'paid_trial', heading: 'The 14 Day Reset' }
    const { container } = render(<EditModeOverlay initialBlocks={[PT, HERO, STATS]} offerLayout={layout} />)

    const region = container.querySelector('[data-pinned-offer]')
    expect(region.querySelector('section#trial')).toBeTruthy()
    // The page's hero block is the photo behind the card, as on the public page.
    expect(region.innerHTML).toContain('https://x/hero.jpg')
    expect(screen.queryByTestId('block-h1')).toBeNull()
    expect(screen.getByTestId('block-s1')).toBeTruthy()
    expect(screen.getByText('Learn more')).toBeTruthy()

    const submit = screen.getByRole('button', { name: /Start my trial/ })
    expect(submit.disabled).toBe(true)
    expect(screen.getByLabelText('Email').disabled).toBe(true)
    fireEvent.submit(screen.getByRole('form', { name: 'Your details' }))
    expect(globalThis.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])

    fireEvent.click(region.querySelector('section'))
    expect(sent('block-clicked')).toEqual([{ namespace: 'lp-editor', type: 'block-clicked', blockId: 'pt1' }])
    // The frosted card's own words are not edited in place (the left panel edits them).
    expect(region.querySelectorAll('[contenteditable]')).toHaveLength(0)
  })

  it('a blocks layout naming its offer block (a studio page) lists it without a toolbar; its studio keys are never posted', () => {
    const PT = { id: 'pt', type: 'paid_trial', heading: 'Try us' }
    render(<EditModeOverlay initialBlocks={[HERO, STATS, PT]} offerLayout={{ kind: 'blocks', cta: { href: null }, offerBlockId: 'pt' }} />)
    expect(screen.getByTestId('block-pt')).toBeTruthy()
    expect(screen.queryByTitle('Delete Paid trial product')).toBeNull()
    expect(screen.queryByTitle(/Move Paid trial product/)).toBeNull()
    expect(screen.queryByTitle('Duplicate Paid trial product')).toBeNull()
    expect(screen.getByTitle('Delete Stats')).toBeTruthy()
    expect(screen.getByTitle('Delete Hero')).toBeTruthy()
    // Nothing else changes: an insert gap before and after every block.
    expect(screen.getAllByRole('button', { name: /Add section here/ })).toHaveLength(4)
  })

  it('a blocks layout adds nothing: every block renders with its toolbar', () => {
    render(<EditModeOverlay initialBlocks={[HERO, STATS]} offerLayout={{ kind: 'blocks', cta: { href: null } }} />)
    expect(screen.getByTestId('block-h1')).toBeTruthy()
    expect(screen.getByTitle('Delete Hero')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Add section here/ })).toHaveLength(3)
  })
})
