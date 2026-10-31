// @vitest-environment jsdom
//
// PAGES.1 — the paid_trial, campaign_funnel and corp_promo block editors say,
// at the top, that the block no longer drives /trial, /<campaign> or /corp
// (those are their own pages now, edited by the team until the Pages editor
// ships), so an operator does not edit copy that no longer reaches the page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import { PaidTrialEdit, CampaignFunnelEdit, CorpPromoEdit, offerBlockNoticeText } from './LandingPageSettingsForm'
import { newBlockOfType } from '@/lib/landing-page-blocks'

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, memberships: [] }) }))
})
afterEach(() => cleanup())

const media = { uploadMedia: vi.fn(), uploading: {}, uploadErr: {}, progress: {} }

describe('the offer block editors carry the Pages notice', () => {
  it('paid_trial: drives this studio page only; /trial is its own page', () => {
    render(<PaidTrialEdit block={newBlockOfType('paid_trial')} onUpdate={vi.fn()} locationId="loc-s" membershipSource="glofox" />)
    const note = screen.getByRole('note')
    expect(note.textContent).toBe('This block drives the trial card on this studio page only. The /trial page is now its own page and, until the Pages editor ships, is edited by the team.')
    expect(note.className).toContain('bg-amber-500/10')
    expect(note.className).toContain('text-amber-700')
  })

  it('campaign_funnel: no longer drives /<campaign>', () => {
    render(<CampaignFunnelEdit block={{ ...newBlockOfType('campaign_funnel'), campaign: '50plus' }} onUpdate={vi.fn()} locationId="loc-s" {...media} />)
    expect(screen.getByRole('note').textContent).toBe('This block no longer drives /50plus. That page is now its own page and, until the Pages editor ships, is edited by the team.')
  })

  it('corp_promo: no longer drives /corp', () => {
    render(<CorpPromoEdit block={newBlockOfType('corp_promo')} onUpdate={vi.fn()} />)
    expect(screen.getByRole('note').textContent).toBe('This block no longer drives /corp. That page is now its own page and, until the Pages editor ships, is edited by the team.')
  })

  it('no other block type has a notice, and no notice carries an em-dash', () => {
    expect(offerBlockNoticeText({ type: 'hero' })).toBeNull()
    expect(offerBlockNoticeText({ type: 'class_funnel' })).toBeNull()
    for (const type of ['paid_trial', 'campaign_funnel', 'corp_promo']) expect(offerBlockNoticeText({ type })).not.toMatch(/[—–]/)
  })
})
