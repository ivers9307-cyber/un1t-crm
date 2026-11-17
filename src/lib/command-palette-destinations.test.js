// PALETTE.1 — the ⌘K palette searches every destination: each hub tab and
// each /settings row, generated from the same data those surfaces render
// from, with the same gate the destination checks.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NAV_COMMANDS,
  CREATE_COMMANDS,
  JUMP_COMMANDS,
  buildJumpCommands,
  generatedJumpCommands,
  commandAllowed,
  commandSublabel,
  visibleCommands,
} from './command-palette'
import { HUB_TABS } from './hub-tabs'
import { HUB_INDEX_CHAINS } from './hub-index-chains'
import { SETTINGS_TREE, settingsRowVisible } from './settings-tree'

const root = process.cwd()
const read = (p) => readFileSync(path.join(root, p), 'utf8')

const PALETTE_HREFS = new Set([...JUMP_COMMANDS, ...CREATE_COMMANDS].map((c) => c.href))
const all = () => true
const granted = (...keys) => (k) => keys.includes(k)

const ORG = 'org-1'
const personas = {
  master: { id: 'm', role: 'master', profileRole: 'master', isMaster: true, activeOrganization: { id: ORG } },
  orgAdminOwner: { id: 'oa', role: 'owner', profileRole: 'owner', orgAdminOrgIds: [ORG], activeOrganization: { id: ORG } },
  owner: { id: 'o', role: 'owner', profileRole: 'owner', orgAdminOrgIds: [], activeOrganization: { id: ORG } },
  manager: { id: 'mg', role: 'manager', profileRole: 'manager', activeOrganization: { id: ORG } },
  headCoach: { id: 'hc', role: 'head_coach', profileRole: 'head_coach', activeOrganization: { id: ORG } },
  staff: { id: 's', role: 'staff', profileRole: 'staff', activeOrganization: { id: ORG } },
  // A master whose ACTIVE studio role is staff: role-gated pages read user.role.
  masterActingStaff: { id: 'ms', role: 'staff', profileRole: 'master', isMaster: true, activeOrganization: { id: ORG } },
}

const hrefsFor = (query, user, hasPerm = all) =>
  visibleCommands([...JUMP_COMMANDS, ...CREATE_COMMANDS], query, hasPerm, user).map((c) => c.href)

describe('PALETTE.1 coverage — nothing a hub or /settings links to is missing', () => {
  const hubTabs = Object.entries(HUB_TABS).flatMap(([hub, h]) =>
    h.tabs.filter((t) => !t.newTab).map((t) => [`${hub} › ${t.label}`, t.href]))
  it.each(hubTabs)('hub tab %s (%s) is in the palette', (_name, href) => {
    expect(PALETTE_HREFS.has(href)).toBe(true)
  })

  const settingsRows = SETTINGS_TREE.flatMap((g) =>
    g.rows.filter((r) => r.href).map((r) => [`${g.label} › ${r.label}`, r.href]))
  it.each(settingsRows)('settings row %s (%s) is in the palette', (_name, href) => {
    expect(PALETTE_HREFS.has(href)).toBe(true)
  })

  it('every literal link on the /settings index page is in the palette', () => {
    const source = read('src/app/settings/page.js')
    const literal = [...source.matchAll(/href="(\/[^"]+)"/g)].map((m) => m[1])
    expect(literal.length).toBeGreaterThan(0) // the Add Location button; keeps the scan honest
    for (const href of literal) expect(PALETTE_HREFS.has(href), `${href} is linked from /settings`).toBe(true)
    // Every other row renders from SETTINGS_TREE, which the rows above cover.
    expect(source).toMatch(/visibleSettingsTree\(/)
  })

  it('every Messages-hub tab is in the palette', () => {
    const source = read('src/components/communications/CommunicationsTabs.jsx')
    const hrefs = [...source.matchAll(/href: '(\/communications\/[^']+)'/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(PALETTE_HREFS.has(href), href).toBe(true)
  })

  // A tab written inline in a layout again would be invisible to the palette.
  it.each([
    'src/app/(sales)/layout.js',
    'src/app/(members)/layout.js',
    'src/app/(money)/layout.js',
    'src/app/(marketing)/layout.js',
    'src/app/(team)/layout.js',
    'src/app/(operations)/layout.js',
    'src/app/communications/(marketing-era)/layout.js',
  ])('%s takes its tabs from src/lib/hub-tabs.js', (file) => {
    const source = read(file)
    expect(source).toMatch(/from '@\/lib\/hub-tabs'/)
    expect(source).not.toMatch(/const TABS = \[/)
  })

  it('offers far more than the 23 hand-kept targets it started with', () => {
    expect(JUMP_COMMANDS.length).toBeGreaterThanOrEqual(55)
  })
})

describe('PALETTE.1 gates — the same gate the destination checks', () => {
  it('a hub tab that a hub-index chain step targets carries exactly that step’s gate', () => {
    for (const [hubHref, hub] of Object.entries(HUB_INDEX_CHAINS)) {
      for (const step of hub.chain) {
        const tab = HUB_TABS[hubHref].tabs.find((t) => t.href === step.target)
        // /settings/landing-page is Marketing's step 2 but the strip's tab is /welcome.
        if (!tab) continue
        expect([...tab.perms].sort(), `${hubHref} ${step.target}`).toEqual([...step.keys].sort())
        expect(tab.roles ? [...tab.roles].sort() : null).toEqual(step.roles ? [...step.roles].sort() : null)
      }
    }
  })

  // Normalised gate, so a curated entry can be compared with the generated one.
  const gateOf = (c) => ({
    keys: c.permission ? [c.permission] : c.anyPermission ? [...c.anyPermission].sort() : null,
    roles: c.roles ? [...c.roles].sort() : null,
    masterOnly: !!c.masterOnly,
    orgAdmin: !!c.orgAdmin,
  })
  it('a curated entry never has a looser gate than the generated one for its href', () => {
    const generated = generatedJumpCommands()
    let compared = 0
    for (const c of NAV_COMMANDS) {
      const g = generated.find((x) => x.href === c.href)
      if (!g) continue
      compared += 1
      expect(gateOf(c), c.href).toEqual(gateOf(g))
    }
    expect(compared).toBeGreaterThanOrEqual(10)
  })

  it('a settings row is shown to exactly the people the /settings index shows it to', () => {
    const generated = generatedJumpCommands()
    const predicates = [all, () => false, granted('settings'), granted('glofox_import', 'landing_page')]
    for (const group of SETTINGS_TREE) {
      for (const row of group.rows.filter((r) => r.href)) {
        const cmd = generated.find((c) => c.id === `settings:${row.id}`)
        for (const user of Object.values(personas)) {
          for (const p of predicates) {
            expect(commandAllowed(cmd, p, user), `${row.id} / ${user.id}`).toBe(settingsRowVisible(row.gate, user, p))
          }
        }
      }
    }
  })

  it('hides manager-only settings from a staff-role user, even one holding every key', () => {
    const hrefs = hrefsFor('', personas.staff)
    for (const href of ['/settings/holidays', '/settings/class-categories', '/settings/pipelines', '/settings/customer-agent', '/settings/hosts', '/settings/staff/new', '/settings/integrations-hub', '/orders', '/challenges', '/communications/segments']) {
      expect(hrefs, href).not.toContain(href)
    }
    // Permission-gated ones stay.
    expect(hrefs).toContain('/settings/staff')
    expect(hrefs).toContain('/schedule/invoices')
  })

  it('shows them to a manager', () => {
    const hrefs = hrefsFor('', personas.manager)
    expect(hrefs).toContain('/settings/holidays')
    expect(hrefs).toContain('/orders')
    expect(hrefs).toContain('/communications/segments')
    expect(hrefs).not.toContain('/settings/staff/new') // master/owner only
  })

  it('hides master-only pages from non-masters', () => {
    for (const persona of ['orgAdminOwner', 'owner', 'manager', 'staff']) {
      const hrefs = hrefsFor('', personas[persona])
      for (const href of ['/settings/audit-log', '/settings/impersonate', '/settings/service-credentials', '/achievements', '/settings/locations/new']) {
        expect(hrefs, `${persona} ${href}`).not.toContain(href)
      }
    }
    const master = hrefsFor('', personas.master)
    for (const href of ['/settings/audit-log', '/settings/impersonate', '/settings/service-credentials', '/achievements', '/settings/locations/new']) {
      expect(master).toContain(href)
    }
  })

  it('organisation pages need an org admin, not a studio owner', () => {
    expect(hrefsFor('', personas.owner)).not.toContain('/settings/api-keys')
    expect(hrefsFor('', personas.orgAdminOwner)).toContain('/settings/api-keys')
    expect(hrefsFor('', personas.orgAdminOwner)).toContain('/settings/billing')
  })

  it('reads the ACTIVE role for role floors, as the pages do', () => {
    const hrefs = hrefsFor('', personas.masterActingStaff)
    expect(hrefs).not.toContain('/orders') // /orders reads user.role
    expect(hrefs).not.toContain('/settings/locations/new') // so does /settings/locations/new
    expect(hrefs).toContain('/settings/audit-log') // masterOnly reads profileRole too
  })

  it('fails closed when the palette cannot tell who the user is', () => {
    const roleGated = JUMP_COMMANDS.filter((c) => c.roles || c.masterOnly || c.orgAdmin || c.openToAll)
    expect(roleGated.length).toBeGreaterThan(10)
    for (const c of roleGated) {
      expect(commandAllowed(c, all), c.id).toBe(false)
      expect(commandAllowed(c, all, null), c.id).toBe(false)
    }
    for (const c of JUMP_COMMANDS.filter((x) => x.roles)) {
      expect(commandAllowed(c, all, { id: 'x' }), `${c.id} with no role`).toBe(false)
    }
  })

  it('the Policies tab is open to any signed-in user and nobody else', () => {
    const policies = JUMP_COMMANDS.find((c) => c.href === '/policies')
    expect(commandAllowed(policies, () => false, personas.staff)).toBe(true)
    expect(commandAllowed(policies, () => false, null)).toBe(false)
  })
})

describe('PALETTE.1 search — words people type', () => {
  const manager = personas.manager
  const master = personas.master
  it.each([
    ['holidays', manager, '/settings/holidays'],
    ['bank holidays', manager, '/settings/holidays'],
    ['Settings › Bank', manager, '/settings/holidays'],
    ['settings holidays', manager, '/settings/holidays'],
    ['api keys', master, '/settings/api-keys'],
    ['API Keys', personas.orgAdminOwner, '/settings/api-keys'],
    ['payroll', manager, '/schedule/invoices'],
    ['payroll', manager, '/schedule/expenses'],
    ['payroll', manager, '/schedule'],
    ['audit', master, '/settings/audit-log'],
    ['audit', manager, '/account/access-history'],
    ['staff', manager, '/settings/staff'],
    ['integrations', personas.owner, '/settings/integrations-hub'],
    ['WhatsApp numbers', personas.owner, '/settings/integrations-hub'],
    ['class fees', manager, '/class-fees'],
    ['segments', manager, '/communications/segments'],
    ['card receipts', manager, '/card-receipts'],
  ])('"%s" finds the page', (query, user, href) => {
    expect(hrefsFor(query, user)).toContain(href)
  })

  it('"WhatsApp numbers" does not also list every WhatsApp page', () => {
    const hrefs = hrefsFor('WhatsApp numbers', personas.owner)
    expect(hrefs).not.toContain('/communications/inbox')
    expect(hrefs).not.toContain('/settings/customer-agent')
  })

  it('"audit" finds nothing a manager cannot open', () => {
    expect(hrefsFor('audit', manager)).not.toContain('/settings/audit-log')
  })

  it('labels each generated result with its section', () => {
    const holidays = JUMP_COMMANDS.find((c) => c.href === '/settings/holidays')
    expect(commandSublabel(holidays)).toBe('Settings › Workspace')
    expect(commandSublabel(JUMP_COMMANDS.find((c) => c.href === '/class-fees'))).toBe('Money')
    expect(commandSublabel({ label: 'x' })).toBe('')
  })
})

describe('PALETTE.1 dedupe', () => {
  it('lists each href once and never repeats a quick-create', () => {
    const hrefs = JUMP_COMMANDS.map((c) => c.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    const creates = new Set(CREATE_COMMANDS.map((c) => c.href))
    for (const h of hrefs) expect(creates.has(h), h).toBe(false)
    // The Marketing strip's Send tab is the 'Send a message' create action.
    expect(hrefs).not.toContain('/communications/send')
  })

  it('keeps the curated label, id and gate where a page is both curated and generated', () => {
    const studio = JUMP_COMMANDS.find((c) => c.href === '/studio-management')
    expect(studio).toMatchObject({ id: 'studio-management', label: 'Studio Management', section: 'Operations' })
    const tasks = JUMP_COMMANDS.find((c) => c.href === '/activities')
    expect(tasks).toMatchObject({ id: 'tasks', label: 'Tasks', permission: 'activities' })
    // Every curated entry is still there, first and in order.
    expect(JUMP_COMMANDS.slice(0, NAV_COMMANDS.length).map((c) => c.id)).toEqual(NAV_COMMANDS.map((c) => c.id))
  })

  it('drops a second generated entry for an href already generated', () => {
    const out = buildJumpCommands([], [
      { id: 'a', label: 'A', href: '/x', openToAll: true },
      { id: 'b', label: 'B', href: '/x', openToAll: true },
    ], [])
    expect(out.map((c) => c.id)).toEqual(['a'])
  })

  it('uses a readable label for the Money hub’s Overview tab', () => {
    expect(JUMP_COMMANDS.find((c) => c.href === '/accounting').label).toBe('Accounting overview')
  })
})
