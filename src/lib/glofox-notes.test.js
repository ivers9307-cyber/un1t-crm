import { describe, it, expect } from 'vitest'
import { buildInteractionDescription, matchesPush } from './glofox-notes.js'

describe('buildInteractionDescription', () => {
  it('prefixes the author and does not truncate short content', () => {
    const r = buildInteractionDescription({ authorName: 'Jane', content: 'Called, keen to join' })
    expect(r.description).toBe('[UN1T CRM · Jane] Called, keen to join')
    expect(r.truncated).toBe(false)
  })
  it('truncates to 500 chars with an ellipsis marker and flags truncated', () => {
    const long = 'x'.repeat(600)
    const r = buildInteractionDescription({ authorName: 'Jane', content: long })
    expect(r.description.length).toBe(500)
    expect(r.description.endsWith('…')).toBe(true)
    expect(r.truncated).toBe(true)
  })
  it('falls back to a neutral author when name missing', () => {
    expect(buildInteractionDescription({ content: 'hi' }).description).toBe('[UN1T CRM] hi')
  })
})

describe('matchesPush', () => {
  const base = { contact_id: 'c1', type: 'NOTE', description: '[UN1T CRM · Jane] hi', pushed_at: '2026-07-04T10:00:00Z' }
  const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  it('matches same contact + type + exact description within 2h', () => {
    const interaction = { type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(true)
  })
  it('no match on different description', () => {
    const interaction = { type: 'NOTE', description: 'something else', created: secs('2026-07-04T10:01:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(false)
  })
  it('no match on different type', () => {
    const interaction = { type: 'MANUAL_EMAIL', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(false)
  })
  it('no match when contactId differs from the push row', () => {
    expect(matchesPush({ type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }, base, 'OTHER')).toBe(false)
  })
  it('no match outside the 2h window', () => {
    const interaction = { type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T13:00:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(false)
  })
  it('null inputs → false (no throw)', () => {
    expect(matchesPush(null, base, 'c1')).toBe(false)
    expect(matchesPush({ type: 'NOTE' }, null, 'c1')).toBe(false)
  })
})
