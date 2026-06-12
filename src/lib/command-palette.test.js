import { describe, it, expect } from 'vitest'
import {
  NAV_COMMANDS,
  CREATE_COMMANDS,
  commandAllowed,
  matchesQuery,
  visibleCommands,
  sanitizeSearchTerm,
} from './command-palette'

// A hasPerm predicate from a set of granted keys.
const granted = (...keys) => (k) => keys.includes(k)
const all = () => true
const none = () => false

describe('commandAllowed', () => {
  it('allows an ungated command', () => {
    expect(commandAllowed({ always: true }, none)).toBe(true)
    expect(commandAllowed({ label: 'x' }, none)).toBe(true) // no gate → allowed
  })
  it('gates on a single permission', () => {
    expect(commandAllowed({ permission: 'pipeline' }, granted('pipeline'))).toBe(true)
    expect(commandAllowed({ permission: 'pipeline' }, granted('contacts'))).toBe(false)
  })
  it('gates on anyPermission (OR)', () => {
    const cmd = { anyPermission: ['email', 'whatsapp'] }
    expect(commandAllowed(cmd, granted('whatsapp'))).toBe(true)
    expect(commandAllowed(cmd, granted('email'))).toBe(true)
    expect(commandAllowed(cmd, granted('pipeline'))).toBe(false)
  })
  it('gates the dashboard group on any dashboard_* key', () => {
    const cmd = { dashboardGroup: true }
    expect(commandAllowed(cmd, granted('dashboard_studio'))).toBe(true)
    expect(commandAllowed(cmd, granted('dashboard_business'))).toBe(true)
    expect(commandAllowed(cmd, none)).toBe(false)
  })
  // SIDEBAR-IA.1 — radars relocated under the dashboard tab strip, so
  // a radar-only user must still see (and be able to jump to) Dashboard.
  it('gates the dashboard group open for radar-only users too', () => {
    const cmd = { dashboardGroup: true }
    expect(commandAllowed(cmd, granted('churn_radar'))).toBe(true)
    expect(commandAllowed(cmd, granted('lead_radar'))).toBe(true)
  })
  it('returns false for a nullish command', () => {
    expect(commandAllowed(null, all)).toBe(false)
  })
})

describe('matchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(matchesQuery('Pipeline', '')).toBe(true)
    expect(matchesQuery('Pipeline', '   ')).toBe(true)
  })
  it('is a case-insensitive substring match', () => {
    expect(matchesQuery('Churn Radar', 'churn')).toBe(true)
    expect(matchesQuery('Churn Radar', 'RAD')).toBe(true)
    expect(matchesQuery('Churn Radar', 'pipeline')).toBe(false)
  })
})

describe('visibleCommands', () => {
  it('applies both the permission gate and the query filter', () => {
    const out = visibleCommands(NAV_COMMANDS, 'rad', granted('churn_radar', 'lead_radar'))
    const ids = out.map((c) => c.id)
    expect(ids).toContain('churn-radar')
    expect(ids).toContain('lead-radar')
    // 'pipeline' would match neither the query nor the granted set
    expect(ids).not.toContain('pipeline')
  })
  // SIDEBAR-IA.1 — the radar jump targets follow the pages under the
  // dashboard tab strip (old standalone URLs are next.config redirects).
  it('points the radar commands at their dashboard-tab homes', () => {
    const byId = Object.fromEntries(NAV_COMMANDS.map((c) => [c.id, c]))
    expect(byId['churn-radar'].href).toBe('/dashboard/churn-radar')
    expect(byId['lead-radar'].href).toBe('/dashboard/lead-radar')
  })
  it('hides commands the user lacks permission for', () => {
    const out = visibleCommands(NAV_COMMANDS, '', granted('contacts'))
    expect(out.map((c) => c.id)).toEqual(['contacts'])
  })
  it('returns the full set for a master-like all-true predicate, sans query', () => {
    expect(visibleCommands(NAV_COMMANDS, '', all).length).toBe(NAV_COMMANDS.length)
  })
  it('gates the create commands too', () => {
    expect(visibleCommands(CREATE_COMMANDS, '', granted('contacts')).map((c) => c.id)).toEqual(['new-contact'])
    expect(visibleCommands(CREATE_COMMANDS, '', none)).toEqual([])
  })
})

describe('sanitizeSearchTerm', () => {
  it('strips PostgREST .or()-breaking characters', () => {
    expect(sanitizeSearchTerm('a,b(c)%_*')).toBe('a b c')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeSearchTerm('  john   doe  ')).toBe('john doe')
  })
  it('returns empty string for nullish/empty input', () => {
    expect(sanitizeSearchTerm(null)).toBe('')
    expect(sanitizeSearchTerm('')).toBe('')
    expect(sanitizeSearchTerm('   ')).toBe('')
  })
  it('leaves a normal email/name search untouched', () => {
    expect(sanitizeSearchTerm('sarah@example.com')).toBe('sarah@example.com')
    expect(sanitizeSearchTerm('Sarah Doyle')).toBe('Sarah Doyle')
  })
})
