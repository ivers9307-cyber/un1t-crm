// @vitest-environment jsdom
//
// PAGES.1 — the pinned offer block: the page half (drawn by the caller's
// renderPageHalf; the form passes the type's editor with pageOnly) and then
// one studio row per studio, in sort order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

import OfferBlockEditor from './OfferBlockEditor'
import { newBlockOfType } from '@/lib/landing-page-blocks'
import { splitOfferBlock } from '@/lib/landing-page-offers'

const MEMBERSHIPS = [{ _id: 'm1', name: 'Intro trial', plans: [{ code: 'p1', name: 'Free week' }] }]
const block = { ...splitOfferBlock(newBlockOfType('campaign_funnel')).page, id: 'b-offer' }
const page = { id: 'p-1', slug: '50plus', title: '50+', kind: 'campaign', scope: 'org', offer_type: 'one_class', blocks: [block] }
const STUDIOS = [
  { location_id: 'loc-h', name: 'UN1T Hatch Street', membership_source: 'un1t_online', enabled: false, sort_order: 1, offer: {}, attribution: {} },
  { location_id: 'loc-s', name: 'UN1T Stillorgan', membership_source: 'glofox', enabled: true, sort_order: 0, offer: { trial_membership_id: 'm1', trial_plan_code: 'p1', class_keywords: '50+' }, attribution: {} },
]

let puts
beforeEach(() => {
  puts = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body)
      puts.push({ url, body })
      return { ok: true, status: 200, json: async () => ({ success: true, data: { row: { ...STUDIOS[1], ...body }, readiness: { ready: true, reason: 'ready' } } }) }
    }
    return { ok: true, json: async () => ({ success: true, memberships: MEMBERSHIPS }) }
  })
})
afterEach(() => cleanup())

// A stand-in page half: one heading input wired to onUpdate.
const renderPageHalf = (b, onUpdate) => (
  <input aria-label="Heading" value={b.heading || ''} onChange={(e) => onUpdate({ heading: e.target.value })} />
)

const mount = (props = {}) => render(
  <OfferBlockEditor
    page={page} block={block} studios={STUDIOS} onUpdateBlock={vi.fn()} onSaveStudio={vi.fn()} canEdit
    renderPageHalf={renderPageHalf}
    {...props}
  />,
)

describe('OfferBlockEditor', () => {
  it('renders a row per studio with switch, type fields and a readiness chip', async () => {
    mount()
    const names = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(names).toEqual(['UN1T Stillorgan', 'UN1T Hatch Street'])
    expect(screen.getAllByRole('checkbox', { name: /^Switched on at / })).toHaveLength(2)
    // Stillorgan (Glofox) picks a plan; Hatch Street (un1t.online) cannot.
    expect(screen.getAllByRole('combobox', { name: 'Glofox trial plan' })).toHaveLength(1)
    expect(screen.getByText('This studio books through un1t.online; Glofox plans do not apply.')).toBeTruthy()
    expect(screen.getAllByLabelText('Classes offered (keywords)')).toHaveLength(2)
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('Needs a plan')).toBeTruthy()
    // The page half comes from renderPageHalf, above the rows.
    const heading = screen.getByLabelText('Heading')
    expect(heading.compareDocumentPosition(screen.getByText('UN1T Stillorgan')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await screen.findByRole('option', { name: 'Intro trial — Free week' })
  })

  it('page-half edits go to onUpdateBlock; a studio save goes to onSaveStudio', async () => {
    const onUpdateBlock = vi.fn()
    const onSaveStudio = vi.fn()
    mount({ onUpdateBlock, onSaveStudio })
    await screen.findByRole('option', { name: 'Intro trial — Free week' })
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Try it' } })
    expect(onUpdateBlock).toHaveBeenCalledWith({ heading: 'Try it' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save UN1T Stillorgan' })) })
    expect(puts.map((p) => p.url)).toEqual(['/api/landing-pages/p-1/studios/loc-s'])
    expect(onSaveStudio).toHaveBeenCalledWith('loc-s', expect.objectContaining({ readiness: { ready: true, reason: 'ready' } }))
  })

  it('no studio rows: says so', () => {
    mount({ studios: [] })
    expect(screen.getByText('No studio is on this page yet.')).toBeTruthy()
  })
})
