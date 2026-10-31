// @vitest-environment jsdom
//
// FIFTYPLUS.1 — the campaign_funnel block editor: the trial picker (required),
// the class keyword list, the video upload, every copy field, the section
// ticks. A second block with the same campaign key is refused.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import { CampaignFunnelEdit, campaignFunnelAddRefusal } from './LandingPageSettingsForm'
import { newBlockOfType } from '@/lib/landing-page-blocks'

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, memberships: [] }) }))
})
afterEach(() => cleanup())

const mount = (block, onUpdate = vi.fn()) => render(
  <CampaignFunnelEdit block={block} onUpdate={onUpdate} locationId="loc-s" uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} brandName="UN1T Stillorgan" />,
)

describe('CampaignFunnelEdit', () => {
  it('shows the trial picker as required, the keyword list, the video upload and every copy field', () => {
    mount(newBlockOfType('campaign_funnel'))
    expect(screen.getByText(/REQUIRED/)).toBeTruthy()
    expect(screen.getByDisplayValue('50+')).toBeTruthy()
    expect(screen.getByText('Add video')).toBeTruthy()
    for (const label of ['Heading', 'Sub-copy', 'Button label', 'Booked — title', 'Booked — message', 'No classes — message', 'Not configured — message', 'Timetable unavailable — message']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
    expect(screen.getByDisplayValue('50plus').readOnly).toBe(true)
  })

  it('writes the trial pair from the picker', () => {
    const onUpdate = vi.fn()
    // A saved pair stays selectable with no catalogue loaded (buildTrialOptions).
    mount({ ...newBlockOfType('campaign_funnel'), trial_membership_id: 'm', trial_plan_code: 'p' }, onUpdate)
    const select = screen.getByRole('combobox', { name: 'Glofox trial plan' })
    expect(select.value).toBe('m:p')
    fireEvent.change(select, { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ trial_membership_id: '', trial_plan_code: '' })
  })

  it('ticks choose the sections', () => {
    const onUpdate = vi.fn()
    mount(newBlockOfType('campaign_funnel'), onUpdate)
    fireEvent.click(screen.getByLabelText('Numbers (stats)'))
    expect(onUpdate).toHaveBeenCalledWith({ show_sections: ['video_testimonials', 'reviews'] })
  })

  it('edits reach the block', () => {
    const onUpdate = vi.fn()
    mount(newBlockOfType('campaign_funnel'), onUpdate)
    fireEvent.change(screen.getByDisplayValue('A free trial of The 50+ Club'), { target: { value: 'Try The 50+ Club' } })
    expect(onUpdate).toHaveBeenCalledWith({ heading: 'Try The 50+ Club' })
    fireEvent.change(screen.getByDisplayValue('50+'), { target: { value: '50+\nelites' } })
    expect(onUpdate).toHaveBeenCalledWith({ class_keywords: '50+\nelites' })
  })
})

describe('CampaignFunnelEdit pageOnly (PAGES.1 page mode)', () => {
  it('no longer shows Page, Sections shown or the duplicate warning', () => {
    render(<CampaignFunnelEdit pageOnly block={newBlockOfType('campaign_funnel')} onUpdate={vi.fn()} locationId="loc-s" uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />)
    expect(screen.queryByText('Page')).toBeNull()
    expect(screen.queryByLabelText('Campaign key')).toBeNull()
    expect(screen.queryByText('Sections under the hero')).toBeNull()
    expect(screen.queryByLabelText('Numbers (stats)')).toBeNull()
    expect(screen.queryByText(/already has a campaign funnel/)).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    // The studio half lives on the studio rows.
    expect(screen.queryByRole('combobox', { name: 'Glofox trial plan' })).toBeNull()
    expect(screen.queryByDisplayValue('50+')).toBeNull()
    expect(screen.queryByText('Tracking (advanced)')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    // The words and the media stay.
    expect(screen.getByText('Heading')).toBeTruthy()
    expect(screen.getByText('Add video')).toBeTruthy()
  })
})

describe('campaignFunnelAddRefusal', () => {
  it('refuses a second campaign_funnel with the same key, allows anything else', () => {
    const existing = [{ type: 'campaign_funnel', campaign: '50plus' }, { type: 'stats' }]
    expect(campaignFunnelAddRefusal(existing, { type: 'campaign_funnel', campaign: '50plus' })).toMatch(/50plus/)
    expect(campaignFunnelAddRefusal(existing, { type: 'campaign_funnel', campaign: 'hyrox' })).toBe(null)
    expect(campaignFunnelAddRefusal(existing, { type: 'stats' })).toBe(null)
  })
})
