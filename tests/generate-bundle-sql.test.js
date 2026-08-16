// TENANT.8 (item 3a) — scripts/generate-bundle-sql.mjs output-shape
// coverage. Fixture-based: exercises the pure functions with small
// synthetic KEY_BUNDLES-shaped inputs rather than depending on the
// live shared/permission-bundles.js content, so this suite doesn't
// need updating every time a real bundle key is added/removed.
import { describe, it, expect } from 'vitest'
import { generateBundleRows, generateInsertSQL } from '../scripts/generate-bundle-sql.mjs'

describe('generateBundleRows', () => {
  it('flattens key -> bundles into one row per (key, bundle) pair', () => {
    const rows = generateBundleRows({ pipeline: ['bundle_sales'], email: ['bundle_messaging', 'bundle_marketing'] })
    expect(rows).toEqual([
      { key: 'email', bundle: 'bundle_marketing' },
      { key: 'email', bundle: 'bundle_messaging' },
      { key: 'pipeline', bundle: 'bundle_sales' },
    ])
  })

  it('sorts by key then bundle regardless of input order — output is stable', () => {
    const a = generateBundleRows({ zeta: ['b2', 'b1'], alpha: ['b1'] })
    const b = generateBundleRows({ alpha: ['b1'], zeta: ['b1', 'b2'] })
    expect(a).toEqual(b)
    expect(a.map((r) => `${r.key}:${r.bundle}`)).toEqual(['alpha:b1', 'zeta:b1', 'zeta:b2'])
  })

  it('a key owning zero bundles contributes no rows', () => {
    expect(generateBundleRows({ core_key: [] })).toEqual([])
  })

  it('defaults to the live KEY_BUNDLES export and produces at least one row', () => {
    // Smoke test against the real module — catches a broken import
    // without hard-coding the live row count (which changes over time).
    expect(generateBundleRows().length).toBeGreaterThan(0)
  })
})

describe('generateInsertSQL', () => {
  it('renders a single well-formed INSERT statement targeting the seed table', () => {
    const sql = generateInsertSQL([{ key: 'pipeline', bundle: 'bundle_sales' }])
    expect(sql).toBe(
      "INSERT INTO private.permission_key_bundles (key, bundle) VALUES\n  ('pipeline', 'bundle_sales');"
    )
  })

  it('comma-joins multiple rows and terminates with a semicolon', () => {
    const sql = generateInsertSQL([
      { key: 'a', bundle: 'bundle_x' },
      { key: 'b', bundle: 'bundle_y' },
    ])
    expect(sql).toContain("('a', 'bundle_x'),\n  ('b', 'bundle_y');")
    expect(sql.endsWith(';')).toBe(true)
  })

  it('refuses to emit a token containing a quote or other unsafe character', () => {
    expect(() => generateInsertSQL([{ key: "pipe'; DROP TABLE x; --", bundle: 'bundle_sales' }]))
      .toThrow(/unsafe token/)
  })

  it('refuses to emit an empty seed — a broken import must fail loudly, not silently truncate the table', () => {
    expect(() => generateInsertSQL([])).toThrow(/zero rows/)
  })
})
