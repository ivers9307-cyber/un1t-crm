// @vitest-environment jsdom
// SALEPAGE.1 — the sale card lists offers as links and never shows an empty
// sale for a failed read.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SaleOffersCard, { saleOffersCopy } from './SaleOffersCard.jsx'

afterEach(cleanup)
const copy = { eyebrow: 'Limited time', heading: 'Offers', subhead: 'Pick one', empty_text: 'Nothing on' }

describe('SaleOffersCard', () => {
  it('links each offer to its own page', () => {
    render(<SaleOffersCard copy={copy} offers={[{ id: 'a', name: '20 Class Pack', bonus: '+5 free', price: '€380', href: '/offers/stillorgan/20-pack' }]} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/offers/stillorgan/20-pack')
    expect(screen.getByText('+5 free')).toBeTruthy()
    expect(screen.getByText('€380')).toBeTruthy()
  })
  it('says when nothing is on, and says something else when the read failed', () => {
    render(<SaleOffersCard copy={copy} offers={[]} />)
    expect(screen.getByText('Nothing on')).toBeTruthy()
    cleanup()
    render(<SaleOffersCard copy={copy} offers={[]} readFailed />)
    expect(screen.getByText(/couldn.t load the offers/)).toBeTruthy()
    expect(screen.queryByText('Nothing on')).toBeNull()
  })
  it('reads its words off the block', () => {
    expect(saleOffersCopy({ heading: ' Hi ', cta_label: 'Go', offer_ids: ['x'] })).toEqual({ eyebrow: '', heading: 'Hi', subhead: '', empty_text: '', cta_label: 'Go' })
  })
})
