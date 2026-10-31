// @vitest-environment jsdom
//
// PAGES.1 — CorpPromoFunnel: with a page it names the page and its studio on
// the claim (the server takes the promo from the page's studio row); without
// one it names the promo alone, as before. A page refusal's machine word
// ('not_found') is never shown to the visitor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/lib/meta-pixel-lead', () => ({ newLeadEventId: () => 'lead-id-123', pixelUserData: () => ({}), fireBrowserLead: vi.fn() }))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [] }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))

import CorpPromoFunnel from './CorpPromoFunnel'

const COPY = {
  title: 'Corp', eyebrow: '', heading: '3 free classes', subhead: '', ticks: [], cta_label: 'Claim', consent_label: 'OK?',
  done_title: 'Done', help_text: 'We will call', unavailable_text: 'Not now',
}
let posts
let answer
beforeEach(() => {
  posts = []
  answer = { status: 200, body: { success: true, data: { title: 'Done', message: 'On your account' } } }
  global.fetch = vi.fn(async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body }
  })
})
afterEach(() => cleanup())

function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Ann' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'ann@work.ie' } })
  fireEvent.change(screen.getByPlaceholderText('Mobile'), { target: { value: '0871234567' } })
  fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
}

describe('CorpPromoFunnel', () => {
  it('without a page the claim names the promo alone', async () => {
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} />)
    fillAndSubmit()
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[0].url).toBe('/api/public/corp-claims')
    expect(posts[0].body).toMatchObject({ promo: 'hatch-3-free', first_name: 'Ann' })
    expect(posts[0].body).not.toHaveProperty('page')
    expect(posts[0].body).not.toHaveProperty('studio')
  })

  it('with a page the claim names the page and its studio', async () => {
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" studio="hatch-street" />)
    fillAndSubmit()
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[0].body).toMatchObject({ page: 'corp', studio: 'hatch-street', promo: 'hatch-3-free' })
  })

  it('a not_found refusal shows the fallback, never the machine word', async () => {
    answer = { status: 404, body: { success: false, error: 'not_found' } }
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" />)
    fillAndSubmit()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('not_found')).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong/)
  })
})
