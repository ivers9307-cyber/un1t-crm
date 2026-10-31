// @vitest-environment jsdom
//
// FIFTYPLUS.1 / PAGES.1 — the campaign_funnel block editor is the page half
// only: the video upload and every copy field. The trial plan, the keywords
// and the tracking are each studio row's (StudioOfferRow); the page's slug
// stands for the campaign key and its own blocks are its sections.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import { CampaignFunnelEdit } from './LandingPageSettingsForm'
import { newBlockOfType } from '@/lib/landing-page-blocks'

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, memberships: [] }) }))
})
afterEach(() => cleanup())

const mount = (block, onUpdate = vi.fn()) => render(
  <CampaignFunnelEdit block={block} onUpdate={onUpdate} uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />,
)

describe('CampaignFunnelEdit', () => {
  it('shows the video upload and every copy field', () => {
    mount(newBlockOfType('campaign_funnel'))
    expect(screen.getByText('Add video')).toBeTruthy()
    for (const label of ['Heading', 'Sub-copy', 'Button label', 'Booked — title', 'Booked — message', 'No classes — message', 'Not configured — message', 'Timetable unavailable — message']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
    expect(screen.getByText('Shown at a studio with no trial plan set on its row.')).toBeTruthy()
  })

  it('no Page, Sections, trial plan, keywords or tracking, and no catalogue load', () => {
    mount(newBlockOfType('campaign_funnel'))
    expect(screen.queryByText('Page')).toBeNull()
    expect(screen.queryByLabelText('Campaign key')).toBeNull()
    expect(screen.queryByText('Sections under the hero')).toBeNull()
    expect(screen.queryByLabelText('Numbers (stats)')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Glofox trial plan' })).toBeNull()
    expect(screen.queryByDisplayValue('50+')).toBeNull()
    expect(screen.queryByText('Tracking (advanced)')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('edits reach the block', () => {
    const onUpdate = vi.fn()
    mount(newBlockOfType('campaign_funnel'), onUpdate)
    fireEvent.change(screen.getByDisplayValue('A free trial of The 50+ Club'), { target: { value: 'Try The 50+ Club' } })
    expect(onUpdate).toHaveBeenCalledWith({ heading: 'Try The 50+ Club' })
    fireEvent.change(screen.getByPlaceholderText('Card 1 title'), { target: { value: 'Your coach' } })
    expect(onUpdate).toHaveBeenCalledWith({ expect_cards: [{ title: 'Your coach', body: expect.any(String) }, expect.any(Object), expect.any(Object)] })
  })
})
