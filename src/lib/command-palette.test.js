import { describe, it, expect } from 'vitest'
import {
  NAV_COMMANDS,
  CREATE_COMMANDS,
  commandAllowed,
  entityResult,
  matchesQuery,
  visibleCommands,
  sanitizeSearchTerm,
  addRecent,
  sanitizeRecents,
  RECENTS_CAP,
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

describe('FEAT-LAUNCH.1 quick actions', () => {
  it('adds send-message / new-broadcast / new-event as permission-gated commands', () => {
    const ids = CREATE_COMMANDS.map((c) => c.id)
    expect(ids).toContain('send-message')
    expect(ids).toContain('new-broadcast')
    expect(ids).toContain('new-event')
    // send-message is any-of comms perms; hidden with none, shown with one.
    const send = CREATE_COMMANDS.find((c) => c.id === 'send-message')
    expect(commandAllowed(send, none)).toBe(false)
    expect(commandAllowed(send, granted('whatsapp'))).toBe(true)
  })
})

describe('addRecent', () => {
  it('prepends, dedupes by href, and caps at RECENTS_CAP', () => {
    let r = []
    r = addRecent(r, { label: 'Pipeline', href: '/pipeline', type: 'go' })
    r = addRecent(r, { label: 'Contacts', href: '/contacts', type: 'go' })
    expect(r.map((x) => x.href)).toEqual(['/contacts', '/pipeline'])
    // revisiting moves it back to the front (no duplicate)
    r = addRecent(r, { label: 'Pipeline', href: '/pipeline', type: 'go' })
    expect(r.map((x) => x.href)).toEqual(['/pipeline', '/contacts'])
    // cap
    for (let i = 0; i < 10; i++) r = addRecent(r, { label: `P${i}`, href: `/p${i}` })
    expect(r.length).toBe(RECENTS_CAP)
  })
  it('ignores items with no href', () => {
    expect(addRecent([{ label: 'x', href: '/x' }], {})).toEqual([{ label: 'x', href: '/x' }])
  })
})

describe('sanitizeRecents', () => {
  it('drops malformed entries and non-internal hrefs', () => {
    const out = sanitizeRecents([
      { label: 'ok', href: '/ok' },
      { label: 'bad-scheme', href: 'https://evil.com' },
      { href: '/no-label' },
      null,
      'nope',
    ])
    expect(out).toEqual([{ label: 'ok', href: '/ok' }])
  })
  it('returns [] for non-array', () => {
    expect(sanitizeRecents(null)).toEqual([])
    expect(sanitizeRecents(undefined)).toEqual([])
  })
})

describe('entityResult', () => {
  it('shapes a contact row with the right href + fallbacks', () => {
    expect(entityResult('contact', { id: 'c1', name: 'Ada', email: 'a@x.ie', phone: '+3531' }))
      .toEqual({ type: 'contact', key: 'contact:c1', label: 'Ada', sublabel: 'a@x.ie', href: '/contacts/c1' })
    // no name → email; sublabel falls to phone
    expect(entityResult('contact', { id: 'c2', email: 'b@x.ie', phone: '+3532' }))
      .toMatchObject({ label: 'b@x.ie', sublabel: 'b@x.ie', href: '/contacts/c2' })
  })
  it('shapes a staff row to the settings/staff detail route', () => {
    expect(entityResult('staff', { id: 's1', full_name: 'Coach Bo', email: 'bo@x.ie' }))
      .toEqual({ type: 'staff', key: 'staff:s1', label: 'Coach Bo', sublabel: 'bo@x.ie', href: '/settings/staff/s1' })
  })
  it('shapes an event row with a passed-through sublabel', () => {
    expect(entityResult('event', { id: 'e1', name: 'Hyrox', sublabel: '12 Aug' }))
      .toEqual({ type: 'event', key: 'event:e1', label: 'Hyrox', sublabel: '12 Aug', href: '/events/e1' })
  })
  it('returns null for an unknown type or an id-less row', () => {
    expect(entityResult('invoice', { id: 'x' })).toBeNull()
    expect(entityResult('contact', {})).toBeNull()
  })
})
