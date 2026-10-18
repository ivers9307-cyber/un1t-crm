// @vitest-environment jsdom
//
// WAORGNUMBER.2 (R5) — one picker per automatic message, listing the studio's
// APPROVED templates of an allowed category; a pick saves at once; a failed
// read shows nothing to pick over. Ids are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import PurposeTemplatesCard from './PurposeTemplatesCard.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000002'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const T = (id, name, over = {}) => ({ id, name, language: 'en', category: 'UTILITY', status: 'APPROVED', ...over })
const NONE = { class_confirmed: null, consult_confirmed: null, event_waitlist_offer: null, meta_ad_welcome: null }

let putBodies
function mockServer({ selected = NONE, canEdit = true, templates, putAnswer, pickAnswer }) {
  putBodies = []
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(init.body))
      return putAnswer(putBodies.at(-1))
    }
    if (u.includes('/whatsapp/purpose-templates')) return pickAnswer || reply(200, { success: true, data: { selected, can_edit: canEdit } })
    if (u.includes('/api/whatsapp/templates')) return reply(200, { success: true, templates })
    return reply(404, {})
  })
}

afterEach(() => { cleanup(); delete global.fetch })

describe('PurposeTemplatesCard', () => {
  it('lists only APPROVED templates of an allowed category in each picker', async () => {
    mockServer({
      templates: [
        T('t1', 'hatch_utility'),
        T('t2', 'hatch_marketing', { category: 'MARKETING' }),
        T('t3', 'hatch_pending', { status: 'PENDING' }),
      ],
    })
    render(<PurposeTemplatesCard locationId={LOC} />)
    const classPicker = await screen.findByLabelText('Class booking confirmed')
    const names = (el) => [...el.querySelectorAll('option')].map((o) => o.textContent)
    expect(names(classPicker)).toEqual([expect.stringContaining('Default'), 'hatch_utility (en)'])
    // The ad welcome may be MARKETING or UTILITY.
    expect(names(screen.getByLabelText('Welcome for new ad leads'))).toEqual([expect.stringContaining('Default'), 'hatch_utility (en)', 'hatch_marketing (en)'])
  })

  it('choosing a template PUTs { purpose, templateId } and shows Saved', async () => {
    const after = { ...NONE, class_confirmed: 't1' }
    mockServer({ templates: [T('t1', 'hatch_utility')], putAnswer: () => reply(200, { success: true, data: { selected: after, can_edit: true } }) })
    render(<PurposeTemplatesCard locationId={LOC} />)
    fireEvent.change(await screen.findByLabelText('Class booking confirmed'), { target: { value: 't1' } })
    await waitFor(() => expect(screen.getByLabelText('Class booking confirmed').value).toBe('t1'))
    expect(putBodies).toEqual([{ purpose: 'class_confirmed', templateId: 't1' }])
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('choosing Default PUTs templateId null', async () => {
    const start = { ...NONE, consult_confirmed: 't1' }
    mockServer({ selected: start, templates: [T('t1', 'x')], putAnswer: () => reply(200, { success: true, data: { selected: NONE, can_edit: true } }) })
    render(<PurposeTemplatesCard locationId={LOC} />)
    const picker = await screen.findByLabelText('Consultation booking confirmed')
    expect(picker.value).toBe('t1')
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(putBodies).toEqual([{ purpose: 'consult_confirmed', templateId: null }]))
  })

  it("the server's refusal is shown and the pick does not change", async () => {
    mockServer({ templates: [T('t1', 'x')], putAnswer: () => reply(400, { success: false, error: 'That template does not belong to this studio.' }) })
    render(<PurposeTemplatesCard locationId={LOC} />)
    fireEvent.change(await screen.findByLabelText('Class booking confirmed'), { target: { value: 't1' } })
    expect(await screen.findByText('That template does not belong to this studio.')).toBeTruthy()
    expect(screen.getByLabelText('Class booking confirmed').value).toBe('')
  })

  it('a pick that is no longer approved is still shown, not silently shown as Default', async () => {
    mockServer({ selected: { ...NONE, class_confirmed: 'gone' }, templates: [T('t1', 'x')] })
    render(<PurposeTemplatesCard locationId={LOC} />)
    const picker = await screen.findByLabelText('Class booking confirmed')
    expect(picker.value).toBe('gone')
    expect(screen.getByText('Chosen template (not approved any more)')).toBeTruthy()
  })

  it('a head coach sees the pickers disabled', async () => {
    mockServer({ canEdit: false, templates: [T('t1', 'x')] })
    render(<PurposeTemplatesCard locationId={LOC} />)
    expect((await screen.findByLabelText('Class booking confirmed')).disabled).toBe(true)
    expect(screen.getByText('An owner or manager can change these.')).toBeTruthy()
  })

  it('a failed read shows a note and no pickers', async () => {
    mockServer({ templates: [], pickAnswer: reply(500, { success: false, error: 'boom' }) })
    render(<PurposeTemplatesCard locationId={LOC} />)
    expect(await screen.findByText(/Could not load these settings/)).toBeTruthy()
    expect(screen.queryByLabelText('Class booking confirmed')).toBeNull()
  })
})
