// Unit tests for the contracts engine (mig 106).
//
// Pure functions only — no Supabase, no Next, no Zod. Just pin
// the variable substitution + state-machine + validation
// behaviour so future regressions surface immediately.

import { describe, it, expect } from 'vitest'
import {
  profileVariables,
  formatEuro,
  mergeVariables,
  customVariablesFrom,
  renderTemplate,
  validateCustomVariables,
  extractPlaceholders,
  unresolvedPlaceholders,
  eligibleTemplatesFor,
  unresolvedPlaceholdersUnion,
  canTransition,
  reminderDue,
  locationVariables,
  LOCATION_VAR_KEYS,
} from './contracts.js'

describe('formatEuro', () => {
  it('formats whole-euro values with no decimals', () => {
    expect(formatEuro(60000)).toMatch(/€60,000/)
    expect(formatEuro(0)).toMatch(/€0/)
  })

  it('formats fractional amounts with two decimals', () => {
    expect(formatEuro(60000.5)).toMatch(/€60,000\.50/)
    expect(formatEuro(25.99)).toMatch(/€25\.99/)
  })

  it('returns empty string for null / undefined / NaN inputs', () => {
    expect(formatEuro(null)).toBe('')
    expect(formatEuro(undefined)).toBe('')
    expect(formatEuro(NaN)).toBe('')
    expect(formatEuro('not a number')).toBe('')
  })
})

describe('profileVariables', () => {
  it('returns empty object for null profile', () => {
    expect(profileVariables(null)).toEqual({})
    expect(profileVariables(undefined)).toEqual({})
  })

  it('extracts identity fields', () => {
    const p = {
      full_name: 'Sarah Doe',
      email: 'sarah@un1tdublin.com',
      role: 'staff',
      employment_type: 'fte',
    }
    const v = profileVariables(p)
    expect(v.full_name).toBe('Sarah Doe')
    expect(v.email).toBe('sarah@un1tdublin.com')
    expect(v.role).toBe('staff')
    expect(v.employment_type).toBe('fte')
  })

  it('exposes both raw and formatted compensation values', () => {
    const p = {
      annual_salary: 65000,
      hourly_rate: 25,
      overtime_rate: 37.5,
      contracted_hours_per_week: 37.5,
    }
    const v = profileVariables(p)
    expect(v.annual_salary_raw).toBe('65000')
    expect(v.annual_salary).toMatch(/€65,000/)
    expect(v.hourly_rate_raw).toBe('25')
    expect(v.hourly_rate).toMatch(/€25/)
    expect(v.overtime_rate_raw).toBe('37.5')
    expect(v.overtime_rate).toMatch(/€37/)
    expect(v.contracted_hours_per_week).toBe('37.5')
  })

  it('always provides today as YYYY-MM-DD', () => {
    const v = profileVariables({})
    expect(v.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('omits keys whose source value is null/undefined (not the empty string)', () => {
    const v = profileVariables({ full_name: 'X', annual_salary: null, hourly_rate: undefined })
    expect(v.full_name).toBe('X')
    expect('annual_salary' in v).toBe(false)
    expect('hourly_rate' in v).toBe(false)
  })
})

describe('mergeVariables', () => {
  it('merges profile-derived first, custom variables override', () => {
    const profile = { full_name: 'Sarah Doe', annual_salary: 60000 }
    const custom = { full_name: 'Sarah Marie Doe', start_date: '2026-06-01' }
    const merged = mergeVariables(profile, custom)
    // Custom overrides profile-derived
    expect(merged.full_name).toBe('Sarah Marie Doe')
    // Profile-derived passes through where not overridden
    expect(merged.annual_salary).toMatch(/€60,000/)
    // Custom-only keys appear
    expect(merged.start_date).toBe('2026-06-01')
  })

  it('handles missing custom variables gracefully', () => {
    expect(mergeVariables({ full_name: 'X' }, null)).toEqual(
      expect.objectContaining({ full_name: 'X' }),
    )
    expect(mergeVariables({ full_name: 'X' }, undefined)).toEqual(
      expect.objectContaining({ full_name: 'X' }),
    )
  })

  // CONTRACTS-VARS.2 — the API route composes location vars into the
  // "custom" argument (mergeVariables' own signature stays
  // profile/custom — see /api/contracts route.js). Pin the resulting
  // three-way precedence: custom > location > profile.
  describe('composed with locationVariables (route call-site pattern)', () => {
    it('custom overrides a same-named location variable, which overrides profile', () => {
      const profile = { full_name: 'Sarah Doe' }
      const loc = locationVariables({
        location: { name: 'UN1T Stillorgan' },
        branding: { companyName: 'UN1T' },
      })
      const custom = { company_name: 'Custom Brand Override' }
      const merged = mergeVariables(profile, { ...loc, ...custom })
      // custom wins over location
      expect(merged.company_name).toBe('Custom Brand Override')
      // location passes through where custom doesn't override it
      expect(merged.location_name).toBe('UN1T Stillorgan')
      // profile passes through untouched
      expect(merged.full_name).toBe('Sarah Doe')
    })

    it('location variables appear when custom has nothing for that key', () => {
      const profile = { full_name: 'Sarah Doe' }
      const loc = locationVariables({
        location: { name: 'UN1T Stillorgan', address: '2 Main St' },
        branding: { companyName: 'UN1T' },
      })
      const merged = mergeVariables(profile, { ...loc, start_date: '2026-08-01' })
      expect(merged.location_name).toBe('UN1T Stillorgan')
      expect(merged.location_address).toBe('2 Main St')
      expect(merged.company_name).toBe('UN1T')
      expect(merged.start_date).toBe('2026-08-01')
    })
  })
})

// CONTRACTS-VARS.2 — location auto-fill variables. Pure function —
// the API route resolves the location row + branding and passes them
// in; this just does the "only non-empty keys" shaping.
describe('locationVariables', () => {
  it('returns all five keys when every field is present', () => {
    const v = locationVariables({
      location: { name: 'UN1T Stillorgan', address: 'Stillorgan SC, Dublin', phone: '01 234 5678', email: 'stillorgan@un1tdublin.com' },
      branding: { companyName: 'UN1T' },
    })
    expect(v).toEqual({
      location_name: 'UN1T Stillorgan',
      location_address: 'Stillorgan SC, Dublin',
      location_phone: '01 234 5678',
      location_email: 'stillorgan@un1tdublin.com',
      company_name: 'UN1T',
    })
  })

  it('omits keys whose source field is null/empty', () => {
    const v = locationVariables({
      location: { name: 'UN1T Stillorgan', address: '', phone: null, email: undefined },
      branding: { companyName: 'UN1T' },
    })
    expect(v).toEqual({ location_name: 'UN1T Stillorgan', company_name: 'UN1T' })
  })

  it('returns an empty object when location and branding are both absent', () => {
    expect(locationVariables({})).toEqual({})
    expect(locationVariables()).toEqual({})
    expect(locationVariables({ location: null, branding: null })).toEqual({})
  })

  it('resolves company_name from branding independently of location fields', () => {
    const v = locationVariables({ location: null, branding: { companyName: 'CCF Autos' } })
    expect(v).toEqual({ company_name: 'CCF Autos' })
  })

  it('LOCATION_VAR_KEYS lists exactly the keys this function can produce', () => {
    const v = locationVariables({
      location: { name: 'a', address: 'b', phone: 'c', email: 'd' },
      branding: { companyName: 'e' },
      entity: { label: 'f' },
    })
    expect(Object.keys(v).sort()).toEqual([...LOCATION_VAR_KEYS].sort())
  })

  // LEGALENT.1 — the contracting COMPANY, distinct from company_name
  // (the brand). Resolved server-side by getContractingEntity() at
  // issue time and always non-empty, so a template's party clause can
  // never be left with an unresolved {{legal_entity_name}}.
  it('resolves legal_entity_name from the entity independently of branding', () => {
    expect(locationVariables({ entity: { label: 'Champ Fitness Ltd (trading as UN1T Dublin)' } }))
      .toEqual({ legal_entity_name: 'Champ Fitness Ltd (trading as UN1T Dublin)' })
    expect(locationVariables({ entity: null })).toEqual({})
  })
})

// CONTRACTS-DRAFT.1 — re-issue prefill uses this to strip
// profile-derived auto-fills out of a previous contract's frozen
// variables_data, leaving only what the issuer actually typed in.
describe('customVariablesFrom', () => {
  const recipient = {
    full_name: 'Sarah Doe',
    email: 'sarah@un1tdublin.com',
    role: 'staff',
    employment_type: 'fte',
    annual_salary: 60000,
    hourly_rate: null,
    overtime_rate: null,
    contracted_hours_per_week: 40,
  }

  it('strips every key profileVariables(recipient) would produce', () => {
    const frozen = {
      ...profileVariables(recipient),
      notice_period_weeks: '4',
      commission_rate: '10',
    }
    const out = customVariablesFrom(frozen, recipient)
    expect(out).toEqual({ notice_period_weeks: '4', commission_rate: '10' })
  })

  it('always strips `today` even though it is profile-derived', () => {
    const frozen = { today: '25 Jul 2026', start_date: '2026-08-01' }
    const out = customVariablesFrom(frozen, recipient)
    expect(out).toEqual({ start_date: '2026-08-01' })
  })

  it('keeps custom variables untouched', () => {
    const frozen = { notice_period_weeks: '4', commission_rate: '10', bonus_clause: 'yes' }
    const out = customVariablesFrom(frozen, recipient)
    expect(out).toEqual(frozen)
  })

  it('handles a null/undefined recipient profile — strips only `today`, keeps the rest', () => {
    const frozen = { today: '25 Jul 2026', full_name: 'Sarah Doe', notice_period_weeks: '4' }
    expect(customVariablesFrom(frozen, null)).toEqual({
      full_name: 'Sarah Doe',
      notice_period_weeks: '4',
    })
    expect(customVariablesFrom(frozen, undefined)).toEqual({
      full_name: 'Sarah Doe',
      notice_period_weeks: '4',
    })
  })

  it('handles null/undefined variablesData gracefully', () => {
    expect(customVariablesFrom(null, recipient)).toEqual({})
    expect(customVariablesFrom(undefined, recipient)).toEqual({})
  })

  it('returns an empty object when everything was profile-derived', () => {
    const frozen = { ...profileVariables(recipient) }
    expect(customVariablesFrom(frozen, recipient)).toEqual({})
  })
})

describe('renderTemplate', () => {
  it('substitutes simple {{var}} placeholders', () => {
    const out = renderTemplate('Hello {{name}}.', { name: 'Sarah' })
    expect(out).toBe('Hello Sarah.')
  })

  it('tolerates whitespace inside the curly braces', () => {
    const out = renderTemplate('Hello {{ name }}.', { name: 'Sarah' })
    expect(out).toBe('Hello Sarah.')
  })

  it('substitutes multiple placeholders independently', () => {
    const out = renderTemplate(
      'Dear {{full_name}},\n\nYour salary is {{annual_salary}}.',
      { full_name: 'Sarah', annual_salary: '€60,000' },
    )
    expect(out).toBe('Dear Sarah,\n\nYour salary is €60,000.')
  })

  it('leaves unknown placeholders intact so the issuer sees them', () => {
    const out = renderTemplate(
      'Salary {{annual_salary}}, bonus {{bonus_pct}}.',
      { annual_salary: '€60,000' },
    )
    expect(out).toContain('Salary €60,000')
    expect(out).toContain('{{bonus_pct}}')
  })

  it('renders empty string when value is null (but the key is present)', () => {
    const out = renderTemplate('Salary {{annual_salary}}.', { annual_salary: null })
    expect(out).toBe('Salary .')
  })

  it('returns empty string for null/undefined body', () => {
    expect(renderTemplate(null, {})).toBe('')
    expect(renderTemplate(undefined, {})).toBe('')
    expect(renderTemplate('', {})).toBe('')
  })

  it('does not match variables that contain dashes or dots', () => {
    // Markdown link refs like [foo][bar] mustn't be eaten — we
    // only match [a-zA-Z0-9_]+ inside the curly braces. Invalid
    // names are left as literal text.
    const out = renderTemplate('See [link][label] and {{my-var}}.', {})
    expect(out).toBe('See [link][label] and {{my-var}}.')
  })
})

describe('validateCustomVariables', () => {
  it('passes when no required vars are declared', () => {
    expect(validateCustomVariables([], {})).toEqual({ ok: true })
    expect(validateCustomVariables(null, null)).toEqual({ ok: true })
  })

  it('passes when all required vars are present', () => {
    const schema = [
      { key: 'notice_period_weeks', required: true },
      { key: 'commission_rate', required: false },
    ]
    expect(validateCustomVariables(schema, {
      notice_period_weeks: 4,
    })).toEqual({ ok: true })
  })

  it('reports missing required vars by key', () => {
    const schema = [
      { key: 'notice_period_weeks', required: true },
      { key: 'start_date', required: true },
      { key: 'commission_rate', required: false },
    ]
    expect(validateCustomVariables(schema, {
      notice_period_weeks: 4,
      // start_date missing
    })).toEqual({ ok: false, missing: ['start_date'] })
  })

  it('treats empty string and null as missing', () => {
    const schema = [{ key: 'start_date', required: true }]
    expect(validateCustomVariables(schema, { start_date: '' })).toEqual({ ok: false, missing: ['start_date'] })
    expect(validateCustomVariables(schema, { start_date: null })).toEqual({ ok: false, missing: ['start_date'] })
  })
})

describe('extractPlaceholders', () => {
  it('returns the unique placeholder names in document order', () => {
    const body = 'Hello {{full_name}}, your role is {{role}}. Welcome, {{full_name}}!'
    expect(extractPlaceholders(body)).toEqual(['full_name', 'role'])
  })

  it('returns empty array for body without placeholders', () => {
    expect(extractPlaceholders('No variables here.')).toEqual([])
    expect(extractPlaceholders('')).toEqual([])
    expect(extractPlaceholders(null)).toEqual([])
  })

  it('ignores invalid placeholder names (with dashes / dots)', () => {
    expect(extractPlaceholders('See {{my-var}} and {{a.b}}')).toEqual([])
  })
})

describe('unresolvedPlaceholders', () => {
  const recipient = {
    full_name: 'Sarah Smith',
    email: 'sarah@example.com',
    role: 'coach',
    hourly_rate: '18.50',
  }

  it('returns [] when every placeholder is either profile- or user-supplied', () => {
    const body = 'Hi {{full_name}}, rate: {{hourly_rate}}, starts on {{commencement_date}}.'
    expect(unresolvedPlaceholders(body, recipient, { commencement_date: '2026-06-01' }))
      .toEqual([])
  })

  it('returns the keys that have neither auto-fill nor a value', () => {
    const body = 'Hi {{full_name}}, sign by {{commencement_date}}, deposit {{deposit_amount}}.'
    expect(unresolvedPlaceholders(body, recipient, {}))
      .toEqual(['commencement_date', 'deposit_amount'])
  })

  it('treats an empty / whitespace-only custom value as still unfilled', () => {
    const body = 'Start: {{commencement_date}}'
    expect(unresolvedPlaceholders(body, recipient, { commencement_date: '   ' }))
      .toEqual(['commencement_date'])
    expect(unresolvedPlaceholders(body, recipient, { commencement_date: '' }))
      .toEqual(['commencement_date'])
  })

  it('treats null/undefined custom values as unfilled', () => {
    const body = 'X: {{x}}'
    expect(unresolvedPlaceholders(body, recipient, { x: null })).toEqual(['x'])
    expect(unresolvedPlaceholders(body, recipient, { x: undefined })).toEqual(['x'])
  })

  it('handles missing recipient defensively (no auto-fills available)', () => {
    const body = 'Hello {{full_name}}.'
    expect(unresolvedPlaceholders(body, null, {})).toEqual(['full_name'])
  })

  // CONTRACTS-VARS.2 — opts.assumeKeys lets a caller (the issue
  // wizard, for LOCATION_VAR_KEYS) declare placeholders as resolved
  // even though neither the profile nor customVariables supplies them.
  describe('opts.assumeKeys', () => {
    it('treats an assumed key as resolved even with no profile/custom value', () => {
      const body = 'At {{location_name}}, hi {{full_name}}.'
      expect(unresolvedPlaceholders(body, recipient, {}, { assumeKeys: ['location_name'] }))
        .toEqual([])
    })

    it('only suppresses the assumed keys — everything else still reports', () => {
      const body = 'At {{location_name}}, sign by {{commencement_date}}.'
      expect(unresolvedPlaceholders(body, recipient, {}, { assumeKeys: ['location_name'] }))
        .toEqual(['commencement_date'])
    })

    it('defaults to no assumed keys when opts is omitted', () => {
      const body = 'At {{location_name}}.'
      expect(unresolvedPlaceholders(body, recipient, {})).toEqual(['location_name'])
    })

    it('an empty assumeKeys array behaves the same as omitting opts', () => {
      const body = 'At {{location_name}}.'
      expect(unresolvedPlaceholders(body, recipient, {}, { assumeKeys: [] }))
        .toEqual(['location_name'])
    })
  })
})

describe('eligibleTemplatesFor (CONTRACTS-BULK.1)', () => {
  const fte = { id: 't-fte', name: 'FTE contract', employment_type: 'fte' }
  const contractor = { id: 't-con', name: 'Contractor agreement', employment_type: 'contractor' }
  const both = { id: 't-both', name: 'Universal NDA', employment_type: 'both' }
  const templates = [fte, contractor, both]

  it('returns every template when no recipients are selected', () => {
    expect(eligibleTemplatesFor([], templates)).toEqual(templates)
    expect(eligibleTemplatesFor(null, templates)).toEqual(templates)
    expect(eligibleTemplatesFor(undefined, templates)).toEqual(templates)
  })

  it('a single fte recipient gets fte + both templates', () => {
    const recipients = [{ id: 'r1', employment_type: 'fte' }]
    expect(eligibleTemplatesFor(recipients, templates)).toEqual([fte, both])
  })

  it('a single contractor recipient gets contractor + both templates', () => {
    const recipients = [{ id: 'r1', employment_type: 'contractor' }]
    expect(eligibleTemplatesFor(recipients, templates)).toEqual([contractor, both])
  })

  it('mixed fte + contractor recipients only leaves the "both" template', () => {
    const recipients = [
      { id: 'r1', employment_type: 'fte' },
      { id: 'r2', employment_type: 'contractor' },
    ]
    expect(eligibleTemplatesFor(recipients, templates)).toEqual([both])
  })

  it('a recipient with unknown/null employment_type only matches "both"', () => {
    expect(eligibleTemplatesFor([{ id: 'r1', employment_type: null }], templates)).toEqual([both])
    expect(eligibleTemplatesFor([{ id: 'r1' }], templates)).toEqual([both])
  })

  it('same-type recipients keep every template that matches that type', () => {
    const recipients = [
      { id: 'r1', employment_type: 'fte' },
      { id: 'r2', employment_type: 'fte' },
    ]
    expect(eligibleTemplatesFor(recipients, templates)).toEqual([fte, both])
  })

  it('handles an empty template list', () => {
    expect(eligibleTemplatesFor([{ id: 'r1', employment_type: 'fte' }], [])).toEqual([])
  })
})

describe('unresolvedPlaceholdersUnion (CONTRACTS-BULK.1)', () => {
  const sarah = { id: 'p1', full_name: 'Sarah Doe', email: 'sarah@example.com', annual_salary: 60000 }
  const john = { id: 'p2', full_name: 'John Smith', email: 'john@example.com' } // no annual_salary

  it('reduces to unresolvedPlaceholders()\'s own list for a single recipient', () => {
    const body = 'Hi {{full_name}}, salary {{annual_salary}}, notice {{notice_period}}.'
    const result = unresolvedPlaceholdersUnion(body, [sarah], { notice_period: '4 weeks' })
    expect(result.map((r) => r.key)).toEqual(
      unresolvedPlaceholders(body, sarah, { notice_period: '4 weeks' })
    )
  })

  it('unions keys missing for ANY recipient even if resolved for others', () => {
    const body = 'Hi {{full_name}}, salary {{annual_salary}}.'
    const result = unresolvedPlaceholdersUnion(body, [sarah, john], {})
    // annual_salary resolves for sarah but not john — still surfaces.
    expect(result.map((r) => r.key)).toEqual(['annual_salary'])
  })

  it('attributes each unresolved key to the recipient(s) it applies to', () => {
    const body = 'Hi {{full_name}}, salary {{annual_salary}}.'
    const result = unresolvedPlaceholdersUnion(body, [sarah, john], {})
    const entry = result.find((r) => r.key === 'annual_salary')
    expect(entry.recipients).toEqual([john])
  })

  it('a key missing for every recipient lists all of them', () => {
    const body = 'Notice: {{notice_period}}.'
    const result = unresolvedPlaceholdersUnion(body, [sarah, john], {})
    const entry = result.find((r) => r.key === 'notice_period')
    expect(entry.recipients).toEqual([sarah, john])
  })

  it('returns [] when every recipient resolves every placeholder', () => {
    const body = 'Hi {{full_name}}.'
    expect(unresolvedPlaceholdersUnion(body, [sarah, john], {})).toEqual([])
  })

  it('handles an empty recipients list', () => {
    expect(unresolvedPlaceholdersUnion('Hi {{full_name}}.', [], {})).toEqual([])
  })

  it('respects opts.assumeKeys the same way unresolvedPlaceholders does', () => {
    const body = 'At {{location_name}}, hi {{full_name}}.'
    expect(unresolvedPlaceholdersUnion(body, [sarah, john], {}, { assumeKeys: ['location_name'] }))
      .toEqual([])
  })
})

describe('canTransition (state machine)', () => {
  it('allows the standard issued -> signed path', () => {
    expect(canTransition('issued', 'signed')).toBe(true)
    expect(canTransition('issued', 'viewed')).toBe(true)
    expect(canTransition('viewed', 'signed')).toBe(true)
  })

  it('allows decline / revoke from any open status', () => {
    expect(canTransition('issued', 'declined')).toBe(true)
    expect(canTransition('issued', 'revoked')).toBe(true)
    expect(canTransition('viewed', 'declined')).toBe(true)
    expect(canTransition('viewed', 'revoked')).toBe(true)
  })

  it('blocks transitions out of terminal statuses', () => {
    for (const terminal of ['signed', 'declined', 'revoked']) {
      expect(canTransition(terminal, 'issued')).toBe(false)
      expect(canTransition(terminal, 'viewed')).toBe(false)
      expect(canTransition(terminal, 'signed')).toBe(false)
    }
  })

  it('blocks no-op same-status transitions', () => {
    expect(canTransition('issued', 'issued')).toBe(false)
    expect(canTransition('signed', 'signed')).toBe(false)
  })

  it('blocks unknown statuses', () => {
    expect(canTransition('made_up', 'signed')).toBe(false)
    expect(canTransition('issued', 'on_fire')).toBe(false)
  })
})

describe('reminderDue', () => {
  const NOW = new Date('2026-07-25T12:00:00.000Z')
  const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

  it('is false when issued less than 3 days ago (reminder_count 0)', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(1), reminder_count: 0 }, NOW)).toBe(false)
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(2.9), reminder_count: 0 }, NOW)).toBe(false)
  })

  it('is true when issued 3+ days ago with reminder_count 0', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(3), reminder_count: 0 }, NOW)).toBe(true)
    expect(reminderDue({ status: 'viewed', issued_at: daysAgo(5), reminder_count: 0 }, NOW)).toBe(true)
  })

  it('is false when issued 3+ but less than 7 days ago with reminder_count 1', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(3), reminder_count: 1 }, NOW)).toBe(false)
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(6.9), reminder_count: 1 }, NOW)).toBe(false)
  })

  it('is true when issued 7+ days ago with reminder_count 1', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(7), reminder_count: 1 }, NOW)).toBe(true)
    expect(reminderDue({ status: 'viewed', issued_at: daysAgo(10), reminder_count: 1 }, NOW)).toBe(true)
  })

  it('is never due once reminder_count reaches the cap of 2', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(100), reminder_count: 2 }, NOW)).toBe(false)
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(365), reminder_count: 5 }, NOW)).toBe(false)
  })

  it('is never due for terminal or pre-issue statuses, regardless of age', () => {
    for (const status of ['signed', 'declined', 'revoked', 'draft']) {
      expect(reminderDue({ status, issued_at: daysAgo(30), reminder_count: 0 }, NOW)).toBe(false)
    }
  })

  it('is false with no issued_at, defensively', () => {
    expect(reminderDue({ status: 'issued', issued_at: null, reminder_count: 0 }, NOW)).toBe(false)
  })

  it('is false for a null/undefined contract', () => {
    expect(reminderDue(null, NOW)).toBe(false)
    expect(reminderDue(undefined, NOW)).toBe(false)
  })

  it('defaults reminder_count to 0 when absent', () => {
    expect(reminderDue({ status: 'issued', issued_at: daysAgo(3) }, NOW)).toBe(true)
  })
})
