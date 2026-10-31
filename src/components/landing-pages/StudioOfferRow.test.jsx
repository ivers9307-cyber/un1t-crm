// @vitest-environment jsdom
//
// PAGES.1 — one studio's half of a page's offer: the switch, the type's
// studio fields, the tracking inputs, a readiness chip and its own Save
// (PUT /api/landing-pages/<id>/studios/<locationId>).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, createEvent } from '@testing-library/react'

import StudioOfferRow from './StudioOfferRow'
import { newBlockOfType } from '@/lib/landing-page-blocks'
import { splitOfferBlock } from '@/lib/landing-page-offers'

const STILL = 'loc-s'
const HATCH = 'loc-h'
const MEMBERSHIPS = [{ _id: 'm1', name: 'Intro trial', plans: [{ code: 'p1', name: 'Free week' }] }]
const PRODUCTS = [{ un1t_id: 'u-14', title: '14 Day Reset', price_cents: 3900 }]

const pageFor = (offerType, blockType) => ({
  id: 'p-1', slug: '50plus', title: '50+', kind: 'campaign', scope: 'one', offer_type: offerType,
  blocks: [{ ...splitOfferBlock(newBlockOfType(blockType)).page, id: 'b-offer' }],
})
const glofoxRow = (over = {}) => ({ location_id: STILL, name: 'UN1T Stillorgan', membership_source: 'glofox', enabled: true, sort_order: 0, offer: {}, attribution: {}, ...over })
const un1tRow = (over = {}) => ({ location_id: HATCH, name: 'UN1T Hatch Street', membership_source: 'un1t_online', enabled: false, sort_order: 1, offer: {}, attribution: {}, ...over })

let puts
let answer
beforeEach(() => {
  puts = []
  answer = null
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body)
      puts.push({ url, body })
      if (answer) return answer(body)
      const locationId = url.split('/').pop()
      return { ok: true, status: 200, json: async () => ({ success: true, data: { row: { location_id: locationId, name: 'x', membership_source: 'glofox', sort_order: 0, ...body }, readiness: { ready: false, reason: 'no_platform' } } }) }
    }
    if (url.includes('glofox-memberships')) return { ok: true, json: async () => ({ success: true, memberships: MEMBERSHIPS }) }
    if (url.includes('un1t-online')) return { ok: true, json: async () => ({ success: true, data: { paid_products: PRODUCTS } }) }
    return { ok: false, json: async () => ({}) }
  })
})
afterEach(() => cleanup())

function mount({ page, row, canEdit = true, onSave = vi.fn() }) {
  render(<StudioOfferRow page={page} row={row} onSave={onSave} canEdit={canEdit} />)
  return { onSave }
}
const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save UN1T Stillorgan' })) }) }

describe('StudioOfferRow', () => {
  it('a campaign_funnel row: trial plan picker and keywords; saving PUTs offer and attribution for that studio only', async () => {
    const { onSave } = mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow({ offer: { class_keywords: '50+' } }) })
    expect(screen.getByText('UN1T Stillorgan')).toBeTruthy()
    expect(screen.getByText('Needs a plan')).toBeTruthy()
    await screen.findByRole('option', { name: 'Intro trial — Free week' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Glofox trial plan' }), { target: { value: 'm1:p1' } })
    // A live hint before the save: the merged block is now configured.
    expect(screen.getByText('Ready')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'still-50' } })
    await save()

    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe('/api/landing-pages/p-1/studios/loc-s')
    expect(puts[0].body).toEqual({
      enabled: true,
      offer: { trial_membership_id: 'm1', trial_plan_code: 'p1', class_keywords: '50+' },
      attribution: { tag: 'still-50' },
    })
    // The server's readiness replaces the local hint.
    expect(screen.getByText('No platform')).toBeTruthy()
    expect(screen.queryByText('Ready')).toBeNull()
    expect(onSave).toHaveBeenCalledWith(STILL, expect.objectContaining({ readiness: { ready: false, reason: 'no_platform' } }))
    expect(onSave.mock.calls[0][1].row.enabled).toBe(true)
  })

  it('placeholders the tracking inputs with the default for the studio path; blank sends no key', async () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow({ public_path: 'stillorgan' }) })
    expect(screen.getByLabelText('Tag').getAttribute('placeholder')).toBe('stillorgan-50plus')
    expect(screen.getByLabelText('Lead source').getAttribute('placeholder')).toBe('meta_50plus')
    expect(screen.getAllByText(/Blank uses the default shown\./)).toHaveLength(2)
    await save()
    expect(puts[0].body.attribution).toEqual({})
    expect(puts[0].body.offer).toEqual({})
  })

  it('a studio whose path is unknown shows no placeholder, only that blank uses its default', () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow({ public_path: null }) })
    expect(screen.getByLabelText('Tag').hasAttribute('placeholder')).toBe(false)
    expect(screen.getByLabelText('Lead source').hasAttribute('placeholder')).toBe(false)
    expect(screen.getAllByText(/Blank uses the default for this studio\./)).toHaveLength(2)
  })

  it('a studio page shows no `<path>-<slug>` placeholder: blank keeps each form\'s own default', () => {
    mount({ page: { ...pageFor('paid_trial', 'paid_trial'), slug: 'stillorgan', kind: 'studio' }, row: glofoxRow({ public_path: 'stillorgan' }) })
    expect(screen.getByLabelText('Tag').hasAttribute('placeholder')).toBe(false)
    expect(screen.getByLabelText('Lead source').hasAttribute('placeholder')).toBe(false)
    expect(screen.getAllByText(/Blank uses the default for this studio\./)).toHaveLength(2)
  })

  it('Enter in a row input does not submit the page form; Enter in a textarea is a new line', () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow() })
    const tag = screen.getByLabelText('Tag')
    const enter = createEvent.keyDown(tag, { key: 'Enter' })
    fireEvent(tag, enter)
    expect(enter.defaultPrevented).toBe(true)
    const keywords = screen.getByLabelText('Classes offered (keywords)')
    const newline = createEvent.keyDown(keywords, { key: 'Enter' })
    fireEvent(keywords, newline)
    expect(newline.defaultPrevented).toBe(false)
  })

  it('at a un1t.online studio the Glofox plan picker gives way to a note', () => {
    for (const [offerType, blockType] of [['one_class', 'campaign_funnel'], ['class_funnel', 'class_funnel']]) {
      render(<StudioOfferRow page={pageFor(offerType, blockType)} row={un1tRow()} onSave={vi.fn()} canEdit />)
      expect(screen.queryByRole('combobox', { name: 'Glofox trial plan' }), blockType).toBeNull()
      expect(screen.getByText('This studio books through un1t.online; Glofox plans do not apply.')).toBeTruthy()
      cleanup()
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('a failed save keeps the typed draft', async () => {
    answer = () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'unavailable' }) })
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow() })
    fireEvent.change(screen.getByLabelText('Classes offered (keywords)'), { target: { value: 'elites' } })
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'still-elites' } })
    await save()
    expect(screen.getByText('The page could not be reached. Try again in a minute.')).toBeTruthy()
    expect(screen.getByLabelText('Classes offered (keywords)').value).toBe('elites')
    expect(screen.getByLabelText('Tag').value).toBe('still-elites')
    await save()
    expect(puts[1].body).toEqual(puts[0].body)
  })

  it('the switch saves enabled', async () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow() })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Switched on at UN1T Stillorgan' }))
    await save()
    expect(puts[0].body.enabled).toBe(false)
  })

  it('keeps a stored Meta page URL it does not edit', async () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow({ attribution: { lead_source: 'meta_x', event_source_url: 'https://www.un1tdublin.com/50plus' } }) })
    await save()
    expect(puts[0].body.attribution).toEqual({ lead_source: 'meta_x', event_source_url: 'https://www.un1tdublin.com/50plus' })
  })

  it('a Glofox paid_trial row: plan picker, price in euros, length, product name and picker label', async () => {
    mount({ page: pageFor('paid_trial', 'paid_trial'), row: glofoxRow({ offer: { currency: 'EUR' } }) })
    await screen.findByRole('option', { name: 'Intro trial — Free week' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Glofox trial plan' }), { target: { value: 'm1:p1' } })
    fireEvent.change(screen.getByLabelText('Price (€)'), { target: { value: '39.50' } })
    fireEvent.change(screen.getByLabelText('Trial length (days)'), { target: { value: '14' } })
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'The 14 Day Reset' } })
    fireEvent.change(screen.getByLabelText('Studio label on the picker'), { target: { value: 'Stillorgan' } })
    expect(screen.queryByRole('combobox', { name: 'un1t.online product' })).toBeNull()
    await save()
    expect(puts[0].body.offer).toEqual({
      currency: 'EUR', membership_id: 'm1', plan_code: 'p1', price_cents: 3950, duration_days: 14,
      product_name: 'The 14 Day Reset', studio_label: 'Stillorgan',
    })
  })

  it('a un1t.online paid_trial row: the product select, no price field', async () => {
    render(<StudioOfferRow page={pageFor('paid_trial', 'paid_trial')} row={un1tRow()} onSave={vi.fn()} canEdit />)
    await screen.findByRole('option', { name: '14 Day Reset · €39' })
    expect(screen.queryByLabelText('Price (€)')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Glofox trial plan' })).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('glofox-memberships'), expect.anything())
    fireEvent.change(screen.getByRole('combobox', { name: 'un1t.online product' }), { target: { value: 'u-14' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save UN1T Hatch Street' })) })
    expect(puts[0].url).toBe('/api/landing-pages/p-1/studios/loc-h')
    expect(puts[0].body.offer).toEqual({ un1t_product_id: 'u-14' })
    expect(puts[0].body.enabled).toBe(false)
  })

  it('a un1t.online paid_trial row the server judged ready shows Ready on first render; without it, the local hint', async () => {
    const row = un1tRow({ enabled: true, offer: { un1t_product_id: 'u-14' }, readiness: { ready: true, reason: 'ready' } })
    render(<StudioOfferRow page={pageFor('paid_trial', 'paid_trial')} row={row} onSave={vi.fn()} canEdit={false} />)
    // The local hint alone cannot judge a un1t.online product (it would say Needs a plan).
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.queryByText('Needs a plan')).toBeNull()
    cleanup()
    render(<StudioOfferRow page={pageFor('paid_trial', 'paid_trial')} row={{ ...row, readiness: undefined }} onSave={vi.fn()} canEdit={false} />)
    expect(screen.getByText('Needs a plan')).toBeTruthy()
  })

  it('a class_funnel row: trial plan, price, consult and the typed timetable with numbers as numbers', async () => {
    mount({ page: pageFor('class_funnel', 'class_funnel'), row: glofoxRow() })
    expect(screen.getByText(/One line per class/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Weekly timetable'), { target: { value: 'Mon 09:00 Strength' } })
    expect(screen.getByText('Ready')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('First bookable date'), { target: { value: '2026-11-02' } })
    fireEvent.change(screen.getByLabelText('Minimum notice (hours)'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Price (€)'), { target: { value: '29' } })
    fireEvent.change(screen.getByLabelText('Free-consult upsell'), { target: { value: 'free-consult' } })
    await save()
    expect(puts[0].body.offer).toEqual({
      price_cents: 2900, consult_slug: 'free-consult', timetable: 'Mon 09:00 Strength',
      timetable_start_date: '2026-11-02', min_notice_hours: 0,
    })
  })

  it('a corp_promo row picks a live promo', async () => {
    mount({ page: pageFor('promo_credits', 'corp_promo'), row: glofoxRow() })
    expect(screen.getByText('Needs a plan')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Promo' }), { target: { value: 'hatch-3-free' } })
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'hatch-3-free · 3 credits' })).toBeTruthy()
    await save()
    expect(puts[0].body.offer).toEqual({ promo_key: 'hatch-3-free' })
  })

  it('a refused save names the field, or shows the API error', async () => {
    answer = () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Invalid request body', issues: [{ path: 'offer.price_cents', message: 'Too big' }] }) })
    mount({ page: pageFor('paid_trial', 'paid_trial'), row: glofoxRow() })
    await save()
    expect(screen.getByText('Invalid value for offer.price_cents')).toBeTruthy()
    answer = () => ({ ok: false, status: 403, json: async () => ({ success: false, error: 'You can view this page but not edit its studios' }) })
    await save()
    expect(screen.getByText('You can view this page but not edit its studios')).toBeTruthy()
    answer = () => ({ ok: false, status: 500, json: async () => ({}) })
    await save()
    expect(screen.getByText('Save failed (500)')).toBeTruthy()
  })

  it('read-only: every control disabled, no Save, no catalogue fetch', () => {
    mount({ page: pageFor('one_class', 'campaign_funnel'), row: glofoxRow(), canEdit: false })
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Glofox trial plan' }).matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Tag').matches(':disabled')).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Switched on at UN1T Stillorgan' }).matches(':disabled')).toBe(true)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
