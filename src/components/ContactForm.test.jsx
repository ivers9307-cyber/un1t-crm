// @vitest-environment jsdom
//
// WAYSIN.5 — ContactForm's lead-source picker offers the studio's vocabulary,
// the nine while it loads, and always the contact's current value.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }) => <a href={href}>{children}</a> }))

import ContactForm from './ContactForm.jsx'
import { DEFAULT_LEAD_SOURCES } from '@/lib/lead-source-vocabulary'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const json = (body) => Promise.resolve({ json: () => Promise.resolve(body) })
const leadSelect = (container) => Array.from(container.querySelectorAll('select'))[0]
const values = (container) => Array.from(leadSelect(container).querySelectorAll('option')).map((o) => o.value)

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(() => json({ success: true, data: { sources: [
    ...DEFAULT_LEAD_SOURCES.map((v) => ({ value: v, label: v, origin: 'default' })),
    { value: 'corp_promo', label: 'corp_promo', origin: 'seen' },
  ] } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ContactForm lead source', () => {
  it('a new contact asks the studio it is created at, and offers its vocabulary', async () => {
    let view
    await act(async () => { view = render(<ContactForm locationId={LOC} />) })
    expect(fetchMock).toHaveBeenCalledWith(`/api/locations/${LOC}/lead-sources`)
    expect(values(view.container)).toEqual(['', ...DEFAULT_LEAD_SOURCES, 'corp_promo'])
  })

  it("editing asks the contact's own studio and keeps a value the vocabulary does not list", async () => {
    let view
    await act(async () => {
      view = render(<ContactForm contact={{ id: 'c1', location_id: 'loc-2', email: 'a@x.com', lead_source: 'Legacy Value' }} />)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/locations/loc-2/lead-sources')
    expect(values(view.container)).toContain('Legacy Value')
    expect(leadSelect(view.container).value).toBe('Legacy Value')
  })

  it('a failed vocabulary read leaves the nine', async () => {
    fetchMock.mockImplementation(() => json({ success: false, error: 'no' }))
    let view
    await act(async () => { view = render(<ContactForm locationId={LOC} />) })
    expect(values(view.container)).toEqual(['', ...DEFAULT_LEAD_SOURCES])
  })
})
