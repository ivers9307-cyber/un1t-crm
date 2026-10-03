// C145 TRIALDEFAULT.1 (Richard, 2 Oct) — a new contact starts with NO credit
// count (trial_credits_remaining NULL) until Glofox says otherwise. The web
// readers that print a count must render NULL as "no count": nothing, or a
// dash where the table needs a cell. Never "0 credits", never "3 credits".

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('./PersonActionBar', () => ({ default: () => null }))
vi.mock('@/components/PersonActionBar', () => ({ default: () => null }))
vi.mock('@/components/AutomationsExemptToggle', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))

const { default: DealCard } = await import('./DealCard.jsx')
const { default: ContactsTable } = await import('./ContactsTable.jsx')
const { default: ContactHeaderBand } = await import('./contact/ContactHeaderBand.jsx')
const { default: GlofoxProfileCard } = await import('./contact/GlofoxProfileCard.jsx')

const text = (html) => html.replace(/<[^>]+>/g, ' ')
const NO_COUNT = { trial_credits_remaining: null }
const NEW_LEAD = { id: 'c-1', name: 'Ada Lovelace', email: 'ada@example.test', pipeline_stage_slug: 'new_lead', location_id: 'l-1', ...NO_COUNT }

describe('C145 — web readers render a NULL credit count as no count', () => {
  it('pipeline DealCard shows no credits badge', () => {
    const html = renderToStaticMarkup(<DealCard deal={{ id: 'd-1', title: 'Ada', contacts: NEW_LEAD }} locationId="l-1" stageName="New Enquiry" />)
    expect(text(html)).not.toMatch(/credits/)
  })

  it('pipeline DealCard still shows a real Glofox count (pin)', () => {
    const html = renderToStaticMarkup(<DealCard deal={{ id: 'd-1', title: 'Ada', contacts: { ...NEW_LEAD, trial_credits_remaining: 2 } }} locationId="l-1" stageName="New Enquiry" />)
    expect(text(html)).toMatch(/2 credits/)
  })

  it('contacts list: a dash in the credits cell, no "credits" line, never 0 or 3', () => {
    const t = text(renderToStaticMarkup(<ContactsTable contacts={[NEW_LEAD]} locationId="l-1" />))
    expect(t).not.toMatch(/\d+ credits/)
    expect(t).toContain('—')
  })

  it('contact header band shows no trial-credit chip', () => {
    const metrics = { ltvCents: 0, arrearsCents: 0, attended: 0, deals: 1, currency: 'EUR' }
    const t = text(renderToStaticMarkup(<ContactHeaderBand contact={NEW_LEAD} metrics={metrics} />))
    expect(t).not.toMatch(/trial credit/)
  })

  it('Glofox profile card (linked, no count yet) shows no credits', () => {
    const t = text(renderToStaticMarkup(<GlofoxProfileCard contact={{ ...NEW_LEAD, glofox_member_id: 'gx-1', glofox_membership_status: 'lead' }} />))
    expect(t).not.toMatch(/\d+ credits?\b/)
  })
})
