// DBTYPES.1 — the snapshot-to-types generator and the opt-in check's helpers.
// The check itself is proven on every run by scripts/fixtures/db-types-must-fail.js.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { tsType, parseArgs, splitTop, renderDatabaseTypes } from '../scripts/lib/db-types.mjs'
import { optedIn, selectErrorIn, missingProofs, REQUIRED_PROOFS } from '../scripts/lib/check-types-core.mjs'

const snapshot = {
  through_migration: 9,
  relations: {
    a: { kind: 'table', rls: true, columns: [['id', 'uuid', false, true], ['n', 'numeric(10,2)', true, false], ['must', 'text', false, false], ['tags', 'text[]', true, false]] },
    v: { kind: 'view', rls: false, columns: [['id', 'uuid', true, false]] },
  },
  functions: [
    ['f', 'p_id uuid, p_tags text[]', 'TABLE(id uuid, c bigint)', false],
    ['t', '', 'trigger', false],
    ['g', '', 'SETOF a', false],
  ],
  enums: {},
  foreign_keys: [['a', ['id'], 'v', ['id']], ['a', ['must'], 'auth.users', ['id']]],
}

describe('database type generation', () => {
  it('maps Postgres types', () => {
    expect(tsType('timestamp with time zone')).toBe('string')
    expect(tsType('numeric(10,2)')).toBe('number')
    expect(tsType('text[]')).toBe('string[]')
    expect(tsType('jsonb')).toBe('Json')
    expect(tsType('character(2)')).toBe('string')
    expect(tsType('some_new_type')).toBe('unknown')
  })
  it('parses arguments, keeping commas inside types', () => {
    expect(splitTop('a numeric(10,2), b text')).toEqual(['a numeric(10,2)', 'b text'])
    expect(parseArgs('p_a uuid, VARIADIC p_b text[], OUT p_c int')).toEqual([['p_a', 'uuid'], ['p_b', 'text[]']])
  })
  it('makes a column optional on insert only if nullable or defaulted', () => {
    const out = renderDatabaseTypes(snapshot)
    expect(out).toContain('Row: { "id": string; "n": number | null; "must": string; "tags": string[] | null }')
    expect(out).toContain('Insert: { "id"?: string; "n"?: number | null; "must": string; "tags"?: string[] | null }')
    expect(out).toContain('Update: { "id"?: string; "n"?: number | null; "must"?: string;')
  })
  it('renders functions, skips triggers, and keeps only public relationships', () => {
    const out = renderDatabaseTypes(snapshot)
    expect(out).toContain('"f": { Args: { "p_id"?: string; "p_tags"?: string[] }; Returns: { "id": string | null; "c": number | null }[] }')
    expect(out).toContain('"g": { Args: {  }; Returns: Row<"a">[] }')
    expect(out).not.toContain('"t": {')
    expect(out).toContain('referencedRelation: "v"')
    expect(out).not.toContain('auth.users')
  })
  it('the checked-in types match the snapshot', () => {
    const snap = JSON.parse(readFileSync('supabase/schema/snapshot.json', 'utf8'))
    expect(readFileSync('supabase/schema/database.d.ts', 'utf8')).toBe(renderDatabaseTypes(snap))
  })
})

describe('the opt-in check', () => {
  it('opts in only on a // @ts-check line near the top', () => {
    expect(optedIn('// @ts-check\nx')).toBe(true)
    expect(optedIn('const a = "// @ts-check"')).toBe(false)
    expect(optedIn(`${'x'.repeat(500)}\n// @ts-check`)).toBe(false)
  })
  it('reads the error supabase-js puts in a bad select type', () => {
    expect(selectErrorIn(`SelectQueryError<"column 'x' does not exist on 'y'.">`)).toBe("column 'x' does not exist on 'y'")
    expect(selectErrorIn('{ id: string }')).toBeNull()
  })
  it('notices when a known mistake stops being caught', () => {
    expect(missingProofs(REQUIRED_PROOFS.map((p) => `f.js:1 ${p}`))).toEqual([])
    expect(missingProofs([])).toEqual([...REQUIRED_PROOFS])
  })
})
