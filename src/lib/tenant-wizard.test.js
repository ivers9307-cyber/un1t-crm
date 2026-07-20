import { describe, it, expect } from 'vitest'
import { deriveWizardState, WIZARD_STEPS } from './tenant-wizard.js'

describe('deriveWizardState (SAAS4-P2 — resumable provisioning wizard)', () => {
  it('starts at the organisation step with nothing in the URL', () => {
    const s = deriveWizardState({})
    expect(s.step).toBe('org')
    expect(s.orgId).toBeNull()
  })

  it('resumes at the location step once an org id is present', () => {
    const s = deriveWizardState({ org: 'org-1' })
    expect(s.step).toBe('location')
    expect(s.orgId).toBe('org-1')
  })

  it('resumes at the owner step once org + location exist', () => {
    expect(deriveWizardState({ org: 'o', loc: 'l' }).step).toBe('owner')
  })

  it('walks branding → domain → done as flags accumulate', () => {
    expect(deriveWizardState({ org: 'o', loc: 'l', invited: '1' }).step).toBe('branding')
    expect(deriveWizardState({ org: 'o', loc: 'l', invited: '1', branded: '1' }).step).toBe('domain')
    expect(deriveWizardState({ org: 'o', loc: 'l', invited: '1', branded: '1', domain: '1' }).step).toBe('done')
  })

  it('skipped steps advance the same as completed ones (branded/domain accept "skip")', () => {
    expect(deriveWizardState({ org: 'o', loc: 'l', invited: '1', branded: 'skip' }).step).toBe('domain')
    expect(deriveWizardState({ org: 'o', loc: 'l', invited: '1', branded: 'skip', domain: 'skip' }).step).toBe('done')
  })

  it('never jumps ahead of missing prerequisites (loc without org is ignored)', () => {
    expect(deriveWizardState({ loc: 'l' }).step).toBe('org')
  })

  it('exports the step list in order for the stepper UI', () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual(['org', 'location', 'owner', 'branding', 'domain', 'done'])
  })
})
