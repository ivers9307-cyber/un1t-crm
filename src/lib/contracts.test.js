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
  renderTemplate,
  validateCustomVariables,
  extractPlaceholders,
  canTransition,
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
