// SETTINGS.2g Task 3 — policy contract for src/lib/settings-tree.js.
//
// Mirrors the shape of src/lib/command-palette.test.js's K5 block: every
// row with an href must resolve to a REAL page under src/app (route-group
// aware — the same findPage/pageFileFor walker, ported rather than
// imported since command-palette.js's test file doesn't export it).

import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { SETTINGS_TREE, settingsRowVisible, visibleSettingsTree } from './settings-tree'
import { MANAGER_ROLES, ADMIN_ROLES } from './schemas'

const APP = path.resolve(process.cwd(), 'src/app')

// Resolve a URL path to its page file, honouring [dynamic] segments AND
// (route-group) directories — ported verbatim from command-palette.test.js
// (see that file's comment for why a group folder must be tried both
// before and interleaved with literal/dynamic matches at every level).
function findPage(dir, segments) {
  if (segments.length === 0) {
    for (const name of ['page.js', 'page.jsx']) {
      const file = path.join(dir, name)
      if (existsSync(file)) return file
    }
  }

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return null
  }

  if (segments.length > 0) {
    const [segment, ...rest] = segments
    const directEntry = entries.find((e) => e.name === segment)
    if (directEntry) {
      const result = findPage(path.join(dir, directEntry.name), rest)
      if (result) return result
    }
  }

  for (const entry of entries) {
    if (/^\(.+\)$/.test(entry.name)) {
      const result = findPage(path.join(dir, entry.name), segments)
      if (result) return result
    }
  }

  if (segments.length > 0) {
    const [segment, ...rest] = segments
    const dynamicEntry = entries.find((e) => /^\[.+\]$/.test(e.name))
    if (dynamicEntry) {
      const result = findPage(path.join(dir, dynamicEntry.name), rest)
      if (result) return result
    }
  }

  return null
}

function pageFileFor(urlPath) {
  const segments = urlPath.split('?')[0].split('/').filter(Boolean)
  return findPage(APP, segments)
}

// Flatten every row across every group, tagged with its group id.
const ALL_ROWS = SETTINGS_TREE.flatMap((group) =>
  group.rows.map((row) => ({ ...row, groupId: group.id }))
)

describe('SETTINGS_TREE structure', () => {
  it('has exactly seven groups', () => {
    expect(SETTINGS_TREE.length).toBe(7)
  })

  it('every group has an id, a label, and at least one row', () => {
    for (const group of SETTINGS_TREE) {
      expect(group.id, 'group missing id').toBeTruthy()
      expect(group.label, `group "${group.id}" missing label`).toBeTruthy()
      expect(Array.isArray(group.rows), `group "${group.id}".rows must be an array`).toBe(true)
      expect(group.rows.length, `group "${group.id}" has no rows`).toBeGreaterThan(0)
    }
  })

  it('group ids are unique', () => {
    const ids = SETTINGS_TREE.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('row ids are unique across the whole tree', () => {
    const ids = ALL_ROWS.map((r) => r.id)
    expect(new Set(ids).size, `duplicate row id among: ${ids.join(', ')}`).toBe(ids.length)
  })

  it.each(ALL_ROWS.map((r) => [r.groupId, r.id, r]))(
    '%s / %s carries a label, a description, and a gate',
    (_g, _id, row) => {
      expect(typeof row.label).toBe('string')
      expect(row.label.length).toBeGreaterThan(0)
      expect(typeof row.description).toBe('string')
      expect(row.description.length).toBeGreaterThan(0)
      expect(row.gate, `${row.id} has no gate`).toBeTruthy()
      const gateKinds = ['permission', 'anyPermission', 'roles', 'masterOnly', 'openToAll']
      const kind = gateKinds.find((k) => row.gate[k] !== undefined)
      expect(kind, `${row.id}'s gate is not one of ${gateKinds.join('/')}`).toBeTruthy()
    }
  )

  it('every row declares an href key — null is a valid, deliberate "coming soon" value', () => {
    for (const row of ALL_ROWS) {
      expect('href' in row, `${row.id} has no href key at all`).toBe(true)
    }
  })

  it('no two rows share the same non-null href', () => {
    const hrefs = ALL_ROWS.map((r) => r.href).filter(Boolean)
    expect(new Set(hrefs).size, `duplicate href among: ${hrefs.join(', ')}`).toBe(hrefs.length)
  })
})

describe('K3 — every settings-tree href resolves to a real page', () => {
  const withHref = ALL_ROWS.filter((r) => r.href)

  it.each(withHref.map((r) => [r.id, r.href]))('%s → %s resolves to a page under src/app', (_id, href) => {
    expect(pageFileFor(href), `${href} has no page.js/page.jsx in src/app`).not.toBeNull()
  })
})

describe('the /admin hrefs pin (2H handoff)', () => {
  it('ADMIN.2h Task 1 pin, AMENDED by FU-DEADLETTER-OWNER-PATH — the tree contains ZERO /admin hrefs EXCEPT the explicit allowlist below. All six former /admin rows (the index card + achievements/audit-log/glofox-import/integrations/marketing-import) left /admin for good, per the original pin. /admin/webhook-dead-letter is a DELIBERATE, later exception: the page legitimately lives at an /admin URL in the platform tier (see src/lib/platform-nav.js) but owners — who pass the page\'s own master-or-owner gate — get no console shell there (AppShell\'s platform branch is master-only) and previously had no persistent nav path at all, only the conditional integration-health remediation link (warn/down status only). This row gives owners a stable door without moving the page.', () => {
    const ADMIN_HREF_ALLOWLIST = ['/admin/webhook-dead-letter']
    const adminHrefs = ALL_ROWS.map((r) => r.href).filter((h) => h && h.startsWith('/admin'))
    expect(adminHrefs).toEqual(ADMIN_HREF_ALLOWLIST)
  })
})

describe('FU-DEADLETTER-OWNER-PATH — webhook dead-letters row', () => {
  const row = ALL_ROWS.find((r) => r.href === '/admin/webhook-dead-letter')

  it('exists, lives in the Integrations group, and points at the real page', () => {
    expect(row).toBeTruthy()
    expect(row.groupId).toBe('integrations')
  })

  it('gates on owner or master — mirrors the page\'s own master-or-owner check exactly', () => {
    expect(row.gate).toEqual({ roles: ['owner', 'master'] })
  })
})

describe('settingsRowVisible()', () => {
  const hasAll = () => true
  const hasNone = () => false

  it('permission gate defers to the hasPerm predicate', () => {
    expect(settingsRowVisible({ permission: 'settings' }, { role: 'staff' }, hasAll)).toBe(true)
    expect(settingsRowVisible({ permission: 'settings' }, { role: 'staff' }, hasNone)).toBe(false)
  })

  it('anyPermission gate is an OR', () => {
    const gate = { anyPermission: ['a', 'b'] }
    expect(settingsRowVisible(gate, {}, (k) => k === 'b')).toBe(true)
    expect(settingsRowVisible(gate, {}, (k) => k === 'c')).toBe(false)
  })

  it('roles gate checks user.role membership', () => {
    const gate = { roles: ['owner', 'master'] }
    expect(settingsRowVisible(gate, { role: 'owner' }, hasNone)).toBe(true)
    expect(settingsRowVisible(gate, { role: 'manager' }, hasAll)).toBe(false)
  })

  it('roles gate works with the shared MANAGER_ROLES/ADMIN_ROLES arrays', () => {
    expect(settingsRowVisible({ roles: MANAGER_ROLES }, { role: 'head_coach' }, hasNone)).toBe(true)
    expect(settingsRowVisible({ roles: MANAGER_ROLES }, { role: 'staff' }, hasNone)).toBe(false)
    expect(settingsRowVisible({ roles: ADMIN_ROLES }, { role: 'manager' }, hasNone)).toBe(true)
    expect(settingsRowVisible({ roles: ADMIN_ROLES }, { role: 'head_coach' }, hasNone)).toBe(false)
  })

  it('masterOnly checks profileRole OR role, same formula as Sidebar.jsx', () => {
    const gate = { masterOnly: true }
    expect(settingsRowVisible(gate, { role: 'master' }, hasNone)).toBe(true)
    expect(settingsRowVisible(gate, { profileRole: 'master', role: 'staff' }, hasNone)).toBe(true)
    expect(settingsRowVisible(gate, { role: 'owner' }, hasNone)).toBe(false)
  })

  it('openToAll is visible to any signed-in user, invisible signed out', () => {
    const gate = { openToAll: true }
    expect(settingsRowVisible(gate, { id: 'u1', role: 'staff' }, hasNone)).toBe(true)
    expect(settingsRowVisible(gate, null, hasNone)).toBe(false)
  })

  it('a row with no gate at all is never visible (fail closed)', () => {
    expect(settingsRowVisible(null, { role: 'master' }, hasAll)).toBe(false)
    expect(settingsRowVisible(undefined, { role: 'master' }, hasAll)).toBe(false)
  })
})

describe('visibleSettingsTree()', () => {
  it('drops rows the user cannot see, and drops a group once every row is gone', () => {
    // A 'staff' role with no permissions can see almost nothing: every
    // Workspace/Team/Communications/Integrations/Billing/Data row needs
    // either an elevated role or a permission this predicate denies.
    // Security survives on its openToAll rows (access-history + the two
    // coming-soon rows) — the only group with no role/permission floor.
    const out = visibleSettingsTree({ role: 'staff', profileRole: 'staff' }, () => false)
    for (const g of out) expect(g.rows.length).toBeGreaterThan(0)
    expect(out.map((g) => g.id)).toEqual(['security'])
    expect(out[0].rows.map((r) => r.id)).toEqual(['access-history', 'two-factor-auth', 'sso'])
  })

  it('a master with every permission sees every group and every row', () => {
    const out = visibleSettingsTree({ role: 'master', profileRole: 'master' }, () => true)
    expect(out.length).toBe(SETTINGS_TREE.length)
    const totalIn = (tree) => tree.reduce((n, g) => n + g.rows.length, 0)
    expect(totalIn(out)).toBe(totalIn(SETTINGS_TREE))
  })
})
