// @vitest-environment jsdom
//
// MCPEMAIL.1 — /communications/campaigns/approve/[token]: the signed-in page an
// approval email links to. It is NOT public: a signed-out visitor goes through
// /login and comes back to this exact path. For a token that is not theirs it
// shows nothing about any campaign.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/campaign-approval-view', async (importOriginal) => ({
  ...(await importOriginal()),
  loadApprovalView: vi.fn(),
}))
vi.mock('@/components/CampaignApproveForm', () => ({
  default: (props) => <div data-testid="form-props">{JSON.stringify(props)}</div>,
}))

import ApprovePage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { loadApprovalView } from '@/lib/campaign-approval-view'

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const CAMPAIGN_ID = 'c0000000-0000-4000-8000-000000000001'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1' })
})

const view = (over = {}) => ({
  ok: true,
  approval: { id: 'ap1', send_at: null, audience_eligible: 100, ...over.approval },
  campaign: { id: CAMPAIGN_ID, name: 'November newsletter', subject: 'News from the studio', status: 'draft', html_content: '<p>secret body</p>', ...over.campaign },
  studio: { id: 'loc-1', name: 'Test Studio', timezone: 'Europe/Dublin' },
  counts: { eligible: 104, matched: 120 },
  sendsAs: 'hello@studio.test',
})

const renderPage = async (token = TOKEN) => render(await ApprovePage({ params: Promise.resolve({ token }) }))

describe('/communications/campaigns/approve/[token]', () => {
  it('redirects a signed-out visitor to login with the approve path preserved', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(renderPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login\?redirect=/)
    const url = redirect.mock.calls[0][0]
    const parsed = new URL(url, 'http://test.local')
    expect(parsed.pathname).toBe('/login')
    expect(parsed.searchParams.get('redirect')).toBe(`/communications/campaigns/approve/${TOKEN}`)
    expect(loadApprovalView).not.toHaveBeenCalled()
  })

  it('shows no campaign details for not_found', async () => {
    loadApprovalView.mockResolvedValue({ ok: false, reason: 'not_found' })
    const { container } = await renderPage()
    expect(screen.queryByTestId('form-props')).toBeNull()
    const text = container.textContent
    expect(text).toMatch(/not valid/i)
    expect(text).not.toMatch(/November newsletter|News from the studio|Test Studio/)
    expect(container.querySelector(`a[href*="${CAMPAIGN_ID}"]`)).toBeNull()
  })

  it('shows the facts and a send-now button for a live approval; the client gets only plain props', async () => {
    loadApprovalView.mockResolvedValue(view())
    const { container } = await renderPage()
    const text = container.textContent
    for (const fact of ['November newsletter', 'News from the studio', 'Test Studio', 'hello@studio.test', '100', '104']) {
      expect(text).toContain(fact)
    }
    expect(text).toMatch(/as soon as you approve/i)
    const props = JSON.parse(screen.getByTestId('form-props').textContent)
    expect(props).toEqual({ token: TOKEN, label: 'Send to 104 people now', whenLabel: null })
    expect(text).not.toContain('secret body')
    expect(container.querySelector(`a[href="/communications/sent/email/${CAMPAIGN_ID}"]`)).not.toBeNull()
  })

  it('names the studio zone and labels the button with the scheduled time', async () => {
    loadApprovalView.mockResolvedValue(view({ approval: { send_at: '2026-11-13T09:00:00.000Z' } }))
    const { container } = await renderPage()
    const props = JSON.parse(screen.getByTestId('form-props').textContent)
    expect(props.label).toMatch(/^Schedule for .*09:00/)
    expect(props.whenLabel).toMatch(/09:00.*Europe\/Dublin/)
    expect(container.textContent).toContain('Europe/Dublin')
  })

  it('a refusal with a known campaign says why and links to it, with no button', async () => {
    loadApprovalView.mockResolvedValue({ ok: false, reason: 'audience_grew', campaign: { id: CAMPAIGN_ID }, tested: 100, now: 130 })
    const { container } = await renderPage()
    expect(screen.queryByTestId('form-props')).toBeNull()
    expect(container.textContent).toMatch(/grown from 100 to 130/)
    expect(container.querySelector(`a[href="/communications/sent/email/${CAMPAIGN_ID}"]`)).not.toBeNull()
  })

  it('a blocked campaign shows the plain sentence and no button', async () => {
    loadApprovalView.mockResolvedValue({ ok: false, reason: 'blocked', campaign: { id: CAMPAIGN_ID }, message: 'This campaign is a resend. Open it in the CRM.' })
    const { container } = await renderPage()
    expect(screen.queryByTestId('form-props')).toBeNull()
    expect(container.textContent).toContain('This campaign is a resend. Open it in the CRM.')
  })
})
