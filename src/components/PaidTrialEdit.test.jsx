// @vitest-environment jsdom
//
// Final-review F2 / M6 — the paid_trial block editor: a un1t.online studio
// edits the new-account email (subject + message); a Glofox studio does not
// see it. Every studio reads the hint to re-check the product's words.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import { PaidTrialEdit } from './LandingPageSettingsForm'
import { newBlockOfType } from '@/lib/landing-page-blocks'
import { PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT } from '@/lib/paid-trial'

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { paid_products: [] }, memberships: [] }) }))
})
afterEach(() => cleanup())

describe('PaidTrialEdit', () => {
  it('a un1t.online studio edits the new-account email; the edit reaches the block', () => {
    const onUpdate = vi.fn()
    render(<PaidTrialEdit block={newBlockOfType('paid_trial')} onUpdate={onUpdate} locationId="loc-h" membershipSource="un1t_online" />)
    expect(screen.getByText('New account email — subject')).toBeTruthy()
    expect(screen.getByText('New account email — message')).toBeTruthy()
    const subject = screen.getByDisplayValue(PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_subject)
    fireEvent.change(subject, { target: { value: 'Your {product_name}' } })
    expect(onUpdate).toHaveBeenCalledWith({ account_email_subject: 'Your {product_name}' })
    const body = screen.getByDisplayValue(PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_body)
    fireEvent.change(body, { target: { value: 'Hi {first_name}' } })
    expect(onUpdate).toHaveBeenCalledWith({ account_email_body: 'Hi {first_name}' })
  })

  it('a Glofox studio does not see the un1t.online account email', () => {
    render(<PaidTrialEdit block={newBlockOfType('paid_trial')} onUpdate={vi.fn()} locationId="loc-s" membershipSource="glofox" />)
    expect(screen.queryByText('New account email — subject')).toBeNull()
  })

  it("shows the hint to check the product's words above the heading", () => {
    render(<PaidTrialEdit block={newBlockOfType('paid_trial')} onUpdate={vi.fn()} locationId="loc-h" membershipSource="un1t_online" />)
    const hint = screen.getByText("Check the heading, button and paid messages name this studio's product.")
    const heading = screen.getByText('Heading')
    expect(hint.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
