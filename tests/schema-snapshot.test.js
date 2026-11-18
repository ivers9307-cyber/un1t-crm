// SCHEMASNAP.1 — the schema snapshot's builder, its comparison with the
// migration replay, and the checked-in file's shape.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { migrationNumber, buildSnapshot, stringifySnapshot, diffSnapshot, validateAllowlist, classifyDrift } from '../scripts/lib/schema-snapshot.mjs'

const columns = { b: { kind: 'table', rls: true, columns: [['id', 'uuid', false, true]] }, a: { kind: 'view', rls: false, columns: [['x', 'text', true, false]] } }
const rest = { functions: [['f', 'p int', 'void', false]], enums: {}, foreign_keys: [['b', ['id'], 'a', ['x']]], latest_applied: '20261118103531' }
const snap = buildSnapshot({ columns, rest, through: 850 })
const replay = (over = {}) => ({ schema: new Map([['a', new Set(['x'])], ['b', new Set(['id'])]]), functionNames: new Set(['f']), ...over })

describe('schema snapshot', () => {
  it('reads migration numbers, including lettered ones', () => {
    expect(migrationNumber('088b_x.sql')).toBe(88)
    expect(migrationNumber('850_y.sql')).toBe(850)
    expect(migrationNumber('notes.sql')).toBeNull()
  })
  it('sorts relations and survives a JSON round trip, one relation per line', () => {
    expect(Object.keys(snap.relations)).toEqual(['a', 'b'])
    const text = stringifySnapshot(snap)
    expect(JSON.parse(text)).toEqual(snap)
    expect(text.split('\n').filter((l) => l.startsWith('    "a":'))).toHaveLength(1)
  })
  it('refuses a snapshot with no migration number', () => {
    expect(() => buildSnapshot({ columns, rest, through: NaN })).toThrow(/through/)
  })
  it('finds no difference when both sides agree', () => {
    expect(diffSnapshot(snap, replay())).toEqual([])
  })
  it('reports tables, columns and functions on either side', () => {
    const d = diffSnapshot(snap, { schema: new Map([['a', new Set(['x', 'ghost'])], ['c', new Set(['y'])]]), functionNames: new Set(['g']) })
    expect(d).toEqual(expect.arrayContaining([
      { key: 'table:b', side: 'live_only' }, { key: 'table:c', side: 'repo_only' },
      { key: 'column:a.ghost', side: 'repo_only' }, { key: 'function:f', side: 'live_only' }, { key: 'function:g', side: 'repo_only' },
    ]))
  })
  it('an allowlisted difference passes until it expires; unlisted ones fail; unused ones are stale', () => {
    const d = [{ key: 'table:b', side: 'live_only' }, { key: 'table:z', side: 'live_only' }]
    const e = { key: 'table:b', side: 'live_only', reason: 'a long enough reason here', expires: '2027-01-01' }
    const stale = { ...e, key: 'table:old' }
    const ok = classifyDrift(d, [e, stale], '2026-12-01')
    expect(ok.failures.map((f) => f.key)).toEqual(['table:z'])
    expect(ok.stale).toEqual([stale])
    expect(classifyDrift(d, [e], '2027-02-01').failures.map((f) => f.key)).toEqual(['table:b', 'table:z'])
  })
  it('rejects a weak allowlist entry', () => {
    expect(validateAllowlist([{ key: 'x', side: 'nope', reason: 'short', expires: 'soon' }])).toHaveLength(3)
  })
  it('the checked-in snapshot is canonical and holds names and types only', () => {
    const text = readFileSync('supabase/schema/snapshot.json', 'utf8')
    const parsed = JSON.parse(text)
    expect(stringifySnapshot(parsed)).toBe(text)
    expect(parsed.relations.contacts.columns.some((c) => c[0] === 'email')).toBe(true)
    expect(Object.keys(parsed.relations.contacts).sort()).toEqual(['columns', 'kind', 'rls'])
  })
})
