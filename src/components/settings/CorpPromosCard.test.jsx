// @vitest-environment jsdom
//
// WAYSIN.4 — the studio's promos card (/settings/promos): rows with Live chips,
// write buttons only with can_edit, a 409 has_claims disables Delete, the key
// is sent only on create, the Glofox fields only at a Glofox studio.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

import CorpPromosCard, { promoBodyFromForm, apiError } from './CorpPromosCard'

const PROMOS = [
  { id: 'p1', key: 'hatch-3-free', name: 'Corporate trial', platform: 'un1t_online', credits: 3, expiresInDays: 7, live: true, tag: 'hatch-corp-promo', leadSource: 'corp_promo', glofox: null },
  { id: 'p2', key: 'old-promo', name: 'Old promo', platform: 'un1t_online', credits: 2, expiresInDays: 14, live: false, tag: 'old', leadSource: 'corp_promo', glofox: null },
]

let calls
function serve({ canEdit = true, platform = 'un1t_online', deleteAnswer, saveAnswer } = {}) {
  calls = []
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (!init.method) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { promos: PROMOS, can_edit: canEdit, platform, public_path: 'hatch-street' } }) }
    }
    if (init.method === 'DELETE') return deleteAnswer()
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ success: true, data: { promo: { ...PROMOS[0], ...('live' in body ? { live: body.live } : {}) } } }) }
    }
    if (saveAnswer) return saveAnswer()
    return { ok: true, status: 201, json: async () => ({ success: true, data: { promo: { ...PROMOS[0], id: 'p3', key: 'new-one', name: 'New one' } } }) }
  })
}

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CorpPromosCard', () => {
  it('renders the rows with Live / Off chips and the owner buttons', async () => {
    serve()
    render(<CorpPromosCard locationId="loc-h" />)
    expect(await screen.findByText('Corporate trial')).toBeTruthy()
    expect(screen.getByText('Old promo')).toBeTruthy()
    expect(screen.getByText('Live').className).toContain('bg-green-500/10 text-green-700')
    expect(screen.getByText('Off').className).toContain('text-gray-700')
    expect(screen.getByRole('button', { name: 'New promo' })).toBeTruthy()
    // Delete only on the switched-off row: a live promo must be switched off first.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
  })

  it('shows Delete only on Off rows', async () => {
    serve()
    render(<CorpPromosCard locationId="loc-h" />)
    const live = (await screen.findByText('Corporate trial')).closest('li')
    const off = screen.getByText('Old promo').closest('li')
    expect([...live.querySelectorAll('button')].some((b) => b.textContent.includes('Delete'))).toBe(false)
    expect([...off.querySelectorAll('button')].some((b) => b.textContent.includes('Delete'))).toBe(true)
  })

  it('a still_live refusal shows the route\'s words', async () => {
    serve({ deleteAnswer: () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'still_live', error: 'Switch this promo off first.' }) }) })
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Old promo')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(screen.getByRole('alert').textContent).toBe('Switch this promo off first.')
    expect(screen.getByText('Old promo')).toBeTruthy()
  })

  it('a blank Credits field is a plain message and nothing is sent', async () => {
    serve()
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    fireEvent.click(screen.getByRole('button', { name: 'New promo' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText(/^Credits/), { target: { value: '' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create promo' })) })
    expect(screen.getByRole('alert').textContent).toBe('Enter the credits.')
    fireEvent.change(screen.getByLabelText(/^Credits/), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/^Expiry/), { target: { value: ' ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create promo' })) })
    expect(screen.getByRole('alert').textContent).toBe('Enter the expiry in days.')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a refused save names the field in words, never the validator\'s text', async () => {
    serve({ saveAnswer: () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Invalid request body', issues: [{ path: 'credits', message: 'Number must be less than or equal to 50' }] }) }) })
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    fireEvent.click(screen.getByRole('button', { name: 'New promo' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(/^Tag/), { target: { value: 'acme' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create promo' })) })
    const alert = screen.getByRole('alert').textContent
    expect(alert).toBe('Credits must be a whole number from 1 to 50.')
    expect(alert).not.toContain('less than or equal')
  })

  it('hides every write button without can_edit', async () => {
    serve({ canEdit: false })
    render(<CorpPromosCard locationId="loc-h" />)
    expect(await screen.findByText('Corporate trial')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New promo' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Switch/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('a refused delete (has_claims) disables Delete with "has claims"', async () => {
    serve({ deleteAnswer: () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'has_claims', error: 'x' }) }) })
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    const btn = screen.getByRole('button', { name: 'Delete (has claims)' })
    expect(btn.matches(':disabled')).toBe(true)
    expect(screen.getByText('Old promo')).toBeTruthy()
  })

  it('Switch off PATCHes live:false only', async () => {
    serve()
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch off' })) })
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch.url).toBe('/api/locations/loc-h/corp-promos/p1')
    expect(patch.body).toEqual({ live: false })
  })

  it('a Glofox studio\'s form asks for the plan fields; a un1t.online studio\'s does not', async () => {
    serve({ platform: 'glofox' })
    render(<CorpPromosCard locationId="loc-s" />)
    await screen.findByText('Corporate trial')
    fireEvent.click(screen.getByRole('button', { name: 'New promo' }))
    expect(screen.getByLabelText(/Glofox plan code/)).toBeTruthy()
    expect(screen.getByText(/Claim link: \/hatch-street\//)).toBeTruthy()
    cleanup()
    serve({ platform: 'un1t_online' })
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    fireEvent.click(screen.getByRole('button', { name: 'New promo' }))
    expect(screen.queryByLabelText(/Glofox plan code/)).toBeNull()
  })

  it('editing locks the key and never sends it', async () => {
    serve()
    render(<CorpPromosCard locationId="loc-h" />)
    await screen.findByText('Corporate trial')
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    expect(screen.getByLabelText(/^Key/).matches(':disabled')).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save promo' })) })
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch.body.key).toBeUndefined()
    expect(patch.body).toMatchObject({ name: 'Corporate trial', credits: 3, expires_in_days: 7 })
  })
})

describe('promoBodyFromForm', () => {
  const form = { key: ' Acme-1 ', name: ' Acme ', credits: '3', expires_in_days: '7', tag: ' Acme_Tag ', lead_source: ' Corp_Promo ', glofox_membership_id: ' m ', glofox_plan_code: 'c', glofox_plan_name: 'n' }
  it('create at a Glofox studio: key and plan fields, lowercased tag and source', () => {
    expect(promoBodyFromForm(form, { platform: 'glofox', creating: true })).toEqual({
      key: 'acme-1', name: 'Acme', credits: 3, expires_in_days: 7, tag: 'acme_tag', lead_source: 'corp_promo',
      glofox_membership_id: 'm', glofox_plan_code: 'c', glofox_plan_name: 'n',
    })
  })
  it('edit at a un1t.online studio: no key, no plan fields', () => {
    const body = promoBodyFromForm(form, { platform: 'un1t_online', creating: false })
    expect(body.key).toBeUndefined()
    expect(body.glofox_plan_code).toBeUndefined()
  })
})

describe('apiError', () => {
  it('maps each issue path to its field words, once per field', () => {
    expect(apiError({ issues: [{ path: 'key', message: 'Key: 3-40 …' }, { path: 'tag', message: 'x' }, { path: 'tag', message: 'y' }] }, 400))
      .toBe('Check the Key: 3 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. A promo\'s key cannot be changed after it is created. Check the Tag: 2 to 40 lowercase letters, digits, - or _.')
  })
  it('an unknown or empty path is a plain sentence, never zod text', () => {
    expect(apiError({ issues: [{ path: '', message: 'Nothing to change' }] }, 400)).toBe('Some of the details are not valid. Check the form and try again.')
  })
  it('without issues it is the route\'s error', () => {
    expect(apiError({ error: 'Switch this promo off first.' }, 409)).toBe('Switch this promo off first.')
    expect(apiError({}, 502)).toBe('Request failed (502)')
  })
})
