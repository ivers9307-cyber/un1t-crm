// @vitest-environment jsdom
//
// WAYSIN.4 — the studio's promos card (/settings/promos): rows with Live chips,
// write buttons only with can_edit, a 409 has_claims disables Delete, the key
// is sent only on create, the Glofox fields only at a Glofox studio.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

import CorpPromosCard, { promoBodyFromForm } from './CorpPromosCard'

const PROMOS = [
  { id: 'p1', key: 'hatch-3-free', name: 'Corporate trial', platform: 'un1t_online', credits: 3, expiresInDays: 7, live: true, tag: 'hatch-corp-promo', leadSource: 'corp_promo', glofox: null },
  { id: 'p2', key: 'old-promo', name: 'Old promo', platform: 'un1t_online', credits: 2, expiresInDays: 14, live: false, tag: 'old', leadSource: 'corp_promo', glofox: null },
]

let calls
function serve({ canEdit = true, platform = 'un1t_online', deleteAnswer } = {}) {
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
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
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
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]) })
    const btn = screen.getByRole('button', { name: 'Delete (has claims)' })
    expect(btn.matches(':disabled')).toBe(true)
    expect(screen.getByText('Corporate trial')).toBeTruthy()
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
  const form = { key: ' Acme-1 ', name: ' Acme ', credits: '3', expires_in_days: '7', tag: ' Acme_Tag ', lead_source: ' Corp Promo ', glofox_membership_id: ' m ', glofox_plan_code: 'c', glofox_plan_name: 'n' }
  it('create at a Glofox studio: key and plan fields, lowercased tag and source', () => {
    expect(promoBodyFromForm(form, { platform: 'glofox', creating: true })).toEqual({
      key: 'acme-1', name: 'Acme', credits: 3, expires_in_days: 7, tag: 'acme_tag', lead_source: 'corp promo',
      glofox_membership_id: 'm', glofox_plan_code: 'c', glofox_plan_name: 'n',
    })
  })
  it('edit at a un1t.online studio: no key, no plan fields', () => {
    const body = promoBodyFromForm(form, { platform: 'un1t_online', creating: false })
    expect(body.key).toBeUndefined()
    expect(body.glofox_plan_code).toBeUndefined()
  })
})
