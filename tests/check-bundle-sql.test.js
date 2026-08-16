// TENANT.8 (item 3a) — scripts/check-bundle-sql.mjs drift-detection
// coverage. Fixture-based against tests/fixtures/bundle-sql-migrations/
// (three files: an initial seed, an unrelated migration with no bundle
// INSERT at all, and a later reseed) plus synthetic {key,bundle} arrays
// for the pure diff/parse functions — none of this depends on the real
// supabase/migrations tree, so it stays stable as that tree grows.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  findLatestSeedMigration,
  parseSeededRows,
  diffBundleRows,
} from '../scripts/check-bundle-sql.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(__dirname, 'fixtures/bundle-sql-migrations')
const FIXTURE_DIR_NONE = join(__dirname, 'fixtures/bundle-sql-migrations-none')

describe('findLatestSeedMigration', () => {
  it('picks the highest-numbered migration that seeds the table, ignoring unrelated ones', () => {
    const latest = findLatestSeedMigration(FIXTURE_DIR)
    expect(latest.file).toBe('010_reseed.sql')
  })

  it('returns null when no migration in the directory seeds the table', () => {
    expect(findLatestSeedMigration(FIXTURE_DIR_NONE)).toBeNull()
  })
})

describe('parseSeededRows', () => {
  it('extracts every (key, bundle) tuple from the seed INSERT', () => {
    const source = `
      INSERT INTO private.permission_key_bundles (key, bundle) VALUES
        ('pipeline', 'bundle_sales'),
        ('email', 'bundle_messaging');
    `
    expect(parseSeededRows(source)).toEqual([
      { key: 'pipeline', bundle: 'bundle_sales' },
      { key: 'email', bundle: 'bundle_messaging' },
    ])
  })

  it('ignores rows inside a SQL comment', () => {
    const source = `
      -- INSERT INTO private.permission_key_bundles (key, bundle) VALUES ('ghost', 'bundle_x');
      INSERT INTO private.permission_key_bundles (key, bundle) VALUES
        ('real', 'bundle_y');
    `
    expect(parseSeededRows(source)).toEqual([{ key: 'real', bundle: 'bundle_y' }])
  })

  it('returns an empty array for a migration with no seed INSERT', () => {
    expect(parseSeededRows('CREATE TABLE foo (id uuid);')).toEqual([])
  })

  it('parses the real fixture files correctly', () => {
    const source = readFileSync(join(FIXTURE_DIR, '010_reseed.sql'), 'utf8')
    expect(parseSeededRows(source)).toEqual([
      { key: 'pipeline', bundle: 'bundle_sales' },
      { key: 'email', bundle: 'bundle_messaging' },
      { key: 'email', bundle: 'bundle_marketing' },
      { key: 'bookings', bundle: 'bundle_members' },
    ])
  })
})

describe('diffBundleRows', () => {
  it('reports in-sync when the sets match regardless of order', () => {
    const generated = [{ key: 'a', bundle: 'x' }, { key: 'b', bundle: 'y' }]
    const seeded = [{ key: 'b', bundle: 'y' }, { key: 'a', bundle: 'x' }]
    expect(diffBundleRows(generated, seeded)).toEqual({ missing: [], extra: [], inSync: true })
  })

  it('flags a row added to KEY_BUNDLES but never re-seeded as missing', () => {
    const generated = [{ key: 'a', bundle: 'x' }, { key: 'new_key', bundle: 'bundle_z' }]
    const seeded = [{ key: 'a', bundle: 'x' }]
    const { missing, extra, inSync } = diffBundleRows(generated, seeded)
    expect(inSync).toBe(false)
    expect(missing).toEqual([{ key: 'new_key', bundle: 'bundle_z' }])
    expect(extra).toEqual([])
  })

  it('flags a row seeded that no longer exists in KEY_BUNDLES as extra', () => {
    const generated = [{ key: 'a', bundle: 'x' }]
    const seeded = [{ key: 'a', bundle: 'x' }, { key: 'removed_key', bundle: 'bundle_z' }]
    const { missing, extra, inSync } = diffBundleRows(generated, seeded)
    expect(inSync).toBe(false)
    expect(missing).toEqual([])
    expect(extra).toEqual([{ key: 'removed_key', bundle: 'bundle_z' }])
  })

  it('can report both missing and extra rows at once (a bundle renamed on a key)', () => {
    const generated = [{ key: 'a', bundle: 'bundle_new' }]
    const seeded = [{ key: 'a', bundle: 'bundle_old' }]
    const { missing, extra, inSync } = diffBundleRows(generated, seeded)
    expect(inSync).toBe(false)
    expect(missing).toEqual([{ key: 'a', bundle: 'bundle_new' }])
    expect(extra).toEqual([{ key: 'a', bundle: 'bundle_old' }])
  })
})

// End-to-end: the real generator output against the real, currently-
// shipped migration — this is the actual CI gate's assertion, run
// inside the test suite too so `npm test` catches drift immediately
// rather than waiting for a separate `npm run check:bundle-sql` step.
describe('the shipped migration stays in sync with KEY_BUNDLES', () => {
  it('supabase/migrations has zero drift against shared/permission-bundles.js', async () => {
    const { generateBundleRows } = await import('../scripts/generate-bundle-sql.mjs')
    const latest = findLatestSeedMigration()
    expect(latest, 'no migration seeds private.permission_key_bundles yet').not.toBeNull()
    const seeded = parseSeededRows(latest.source)
    const { inSync, missing, extra } = diffBundleRows(generateBundleRows(), seeded)
    expect({ missing, extra }, `drift against ${latest.file}`).toEqual({ missing: [], extra: [] })
    expect(inSync).toBe(true)
  })
})
