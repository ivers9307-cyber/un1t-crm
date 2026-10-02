// @vitest-environment jsdom
//
// C140 CONTRACTRECIPIENT.1 (folds C138 d) — the issue wizard listed the
// issuer's people at every studio and every template the issuer owns, so an
// owner of two orgs could pair org A's template with a person only in org B
// (POST /api/contracts now refuses that). The template list holds only
// templates in an org every selected person belongs to, and once a template
// is chosen the people list holds only that org's people. Fictional ids.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import ContractIssueWizard from './ContractIssueWizard'

const locationOrgs = { 'loc-a': 'org-a', 'loc-b': 'org-b' }
const staff = [
  { id: 'p-a', full_name: 'Alex InA', email: 'a@example.test', employment_type: 'fte', profile_locations: [{ location_id: 'loc-a' }] },
  { id: 'p-b', full_name: 'Bea InB', email: 'b@example.test', employment_type: 'fte', profile_locations: [{ location_id: 'loc-b' }] },
  { id: 'p-ab', full_name: 'Cam InBoth', email: 'c@example.test', employment_type: 'fte', profile_locations: [{ location_id: 'loc-b' }, { location_id: 'loc-a' }] },
]
const templates = [
  { id: 't-a', name: 'Org A contract', version: 1, organization_id: 'org-a', employment_type: 'both', active: true, body_markdown: 'Hi', variables_schema: [] },
  { id: 't-b', name: 'Org B contract', version: 1, organization_id: 'org-b', employment_type: 'both', active: true, body_markdown: 'Hi', variables_schema: [] },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const body = String(url).startsWith('/api/staff') ? { success: true, data: staff } : { success: true, data: templates }
    return { ok: true, status: 200, json: async () => body }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const who = (name) => (_c, el) => el?.tagName === 'SPAN' && el.textContent.startsWith(name)
const options = () => within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)

describe('ContractIssueWizard lists one organisation at a time (C140)', () => {
  it('a person in org A is offered only org A\'s template; a person in both, both', async () => {
    render(<ContractIssueWizard issuerName="Issuer" locationOrgs={locationOrgs} />)
    fireEvent.click(await screen.findByText(who('Alex InA')))
    expect(options()).toEqual(['Pick a template…', 'Org A contract (v1)'])
    fireEvent.click(screen.getByText(who('Alex InA')))
    fireEvent.click(screen.getByText(who('Cam InBoth')))
    expect(options()).toEqual(['Pick a template…', 'Org A contract (v1)', 'Org B contract (v1)'])
  })

  it('people in two different orgs together are offered neither org\'s template', async () => {
    render(<ContractIssueWizard issuerName="Issuer" locationOrgs={locationOrgs} />)
    fireEvent.click(await screen.findByText(who('Alex InA')))
    fireEvent.click(screen.getByText(who('Bea InB')))
    expect(options()).toEqual(['Pick a template…'])
  })

  it('once org A\'s template is chosen, only org A\'s people are listed', async () => {
    render(<ContractIssueWizard issuerName="Issuer" locationOrgs={locationOrgs} />)
    fireEvent.click(await screen.findByText(who('Alex InA')))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 't-a' } })
    await waitFor(() => expect(screen.queryByText(who('Bea InB'))).toBeNull())
    expect(screen.getByText(who('Alex InA'))).toBeTruthy()
    expect(screen.getByText(who('Cam InBoth'))).toBeTruthy()
  })
})
