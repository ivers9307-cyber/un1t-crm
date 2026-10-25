// MIAORG.1 Task 4 fix round — the org editor's field list is pinned to the
// inheritable catalogue (settings-overrides.js): every inheritable path is
// either shown by the org editor or listed in ORG_FIELDS_NOT_EDITED, except
// the two an organisation can never hold (quiet_hours.off, a studio's opt-out;
// quiet_hours.tz, each studio's own clock). A new inheritable setting fails
// here until the org editor shows it or lists it as excluded.
import { describe, it, expect } from 'vitest'
import {
  INHERITABLE_SCALAR_KEYS, INHERITABLE_OBJECT_KEYS, INHERITABLE_OBJECT_FIELDS, STUDIO_ONLY_KEYS,
} from '@/lib/agent/settings-overrides'
import { ORG_EXCLUDED_FIELDS } from '@/lib/agent/settings-org'
import { ORG_FIELDS, ORG_FIELDS_NOT_EDITED } from './org-fields'

const leaves = (path) => (INHERITABLE_OBJECT_KEYS.includes(path)
  ? INHERITABLE_OBJECT_FIELDS[path].map((f) => `${path}.${f}`)
  : [path])

const catalogue = [
  ...INHERITABLE_SCALAR_KEYS,
  ...INHERITABLE_OBJECT_KEYS.flatMap(leaves),
].filter((p) => !ORG_EXCLUDED_FIELDS.has(p)).sort()

describe('org-fields.js covers the inheritable catalogue', () => {
  it('shown fields + documented exclusions = the catalogue minus quiet_hours.off and .tz', () => {
    const shown = ORG_FIELDS.flatMap((f) => f.paths.flatMap(leaves)).filter((p) => !ORG_EXCLUDED_FIELDS.has(p))
    const excluded = ORG_FIELDS_NOT_EDITED.flatMap(leaves)
    expect([...shown, ...excluded].sort()).toEqual(catalogue)
  })

  it('no path is both shown and excluded, and none is shown twice', () => {
    const shown = ORG_FIELDS.flatMap((f) => f.paths.flatMap(leaves))
    expect(new Set(shown).size).toBe(shown.length)
    const excluded = new Set(ORG_FIELDS_NOT_EDITED.flatMap(leaves))
    expect(shown.filter((p) => excluded.has(p))).toEqual([])
  })

  it('the excluded pair really is excluded from the org layer', () => {
    expect([...ORG_EXCLUDED_FIELDS].sort()).toEqual(['quiet_hours.off', 'quiet_hours.tz'])
  })

  it('no studio-only key is shown', () => {
    for (const f of ORG_FIELDS) for (const p of f.paths) expect(STUDIO_ONLY_KEYS.has(p.split('.')[0]), p).toBe(false)
  })
})
