// src/lib/geofence-permission-chips.test.js
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  GEOFENCE_PERMISSION_VALUES,
  GEOFENCE_PERMISSION_CHIPS,
  CHIP_TONE_CLASSES,
  geofencePermissionChip,
} from './geofence-permission-chips.js'

// GEO-ATT.22 — the registry's whole job is that the DB, the API and the three
// operator surfaces cannot drift apart. Scanning the migrations is what makes
// this a real guard rather than a restatement: add a value to the CHECK without
// a chip (an operator sees a blank "—" for a state we added to be VISIBLE), or
// add a chip for a value the DB rejects, and this fails. Same shape as
// merge-tags.test.js scanning postmark.js.
function checkConstraintValues() {
  const dir = path.join(process.cwd(), 'supabase/migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  let latest = null
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    if (!/device_tokens_geofence_permission_check/.test(sql)) continue
    // Only the ADD (the DROP carries the name too, with no value list).
    const add = sql.split(/ADD\s+CONSTRAINT\s+device_tokens_geofence_permission_check/i)[1]
    if (!add) continue
    const values = [...add.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
    if (values.length) latest = values
  }
  return latest
}

describe('geofence permission chips ↔ the database', () => {
  it('finds the CHECK constraint in the migrations at all', () => {
    expect(checkConstraintValues()).not.toBeNull()
  })

  it('covers exactly the values the DB accepts, in both directions', () => {
    const fromDb = checkConstraintValues().slice().sort()
    expect(GEOFENCE_PERMISSION_VALUES.slice().sort()).toEqual(fromDb)
  })

  it('gives every accepted value a chip, so none renders as a blank dash', () => {
    for (const v of GEOFENCE_PERMISSION_VALUES) {
      expect(GEOFENCE_PERMISSION_CHIPS[v], `no chip for "${v}"`).toBeTruthy()
    }
  })

  it('has no chip for a value the DB would reject', () => {
    for (const v of Object.keys(GEOFENCE_PERMISSION_CHIPS)) {
      expect(GEOFENCE_PERMISSION_VALUES, `chip "${v}" is not a DB value`).toContain(v)
    }
  })
})

describe('geofencePermissionChip', () => {
  it('resolves tone to classes so callers never re-roll the palette', () => {
    const chip = geofencePermissionChip('always')
    expect(chip.label).toBe('Always')
    expect(chip.className).toBe(CHIP_TONE_CLASSES.green)
  })

  it('renders the unreadable state as a fault, not as neutral', () => {
    // GEO-ATT.21's point: 'unknown' means geofencing is NOT running on that
    // handset. Showing it in the same grey as "Not asked" would bury it.
    expect(geofencePermissionChip('unknown').className).toBe(CHIP_TONE_CLASSES.red)
  })

  it('returns null for null/unknown input so callers can render the dash', () => {
    // null = never reported. Deliberately NOT a denial — that distinction is
    // the diagnostic value, and it predates this registry.
    expect(geofencePermissionChip(null)).toBeNull()
    expect(geofencePermissionChip(undefined)).toBeNull()
    expect(geofencePermissionChip('nonsense')).toBeNull()
  })

  it('every tone in the registry has classes behind it', () => {
    for (const [value, entry] of Object.entries(GEOFENCE_PERMISSION_CHIPS)) {
      expect(CHIP_TONE_CLASSES[entry.tone], `tone "${entry.tone}" (${value}) has no classes`).toBeTruthy()
    }
  })

  it('uses the -700 text ramp on light cards (the chip-contrast rule)', () => {
    for (const cls of Object.values(CHIP_TONE_CLASSES)) {
      expect(cls).toMatch(/text-[a-z]+-700/)
    }
  })
})
