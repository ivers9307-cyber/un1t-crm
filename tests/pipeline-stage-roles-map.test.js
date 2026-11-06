import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_ROLE_BY_SLUG } from '../shared/pipelines/stage-roles.js'

const dir = path.resolve(import.meta.dirname, '../supabase/migrations')
const file = readdirSync(dir).find((f) => f.startsWith('814_'))
const sql = readFileSync(path.join(dir, file), 'utf8')

// UPDATE ... SET stage_role = '<role>'[, role_config = '<json>'] ... AND slug IN (...)
const groups = [...sql.matchAll(/SET stage_role = '(\w+)'(?:, role_config = '(\{[^']*\})'::jsonb)?\s*WHERE stage_role = 'custom'\s*AND slug IN \(([^)]*)\)/g)]
  .map((m) => ({ role: m[1], config: m[2] ? JSON.parse(m[2]) : {}, slugs: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]) }))

describe('DEFAULT_ROLE_BY_SLUG matches mig 814', () => {
  it('finds the seven backfill groups', () => {
    expect(groups.map((g) => g.role)).toEqual(['new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile'])
  })
  it('every migration slug is in the map with the same role and config', () => {
    for (const g of groups) {
      for (const slug of g.slugs) {
        expect(DEFAULT_ROLE_BY_SLUG[slug], slug).toEqual({ stage_role: g.role, role_config: g.config })
      }
    }
  })
  it('the map names no slug the migration does not', () => {
    const all = new Set(groups.flatMap((g) => g.slugs))
    expect(Object.keys(DEFAULT_ROLE_BY_SLUG).filter((s) => !all.has(s))).toEqual([])
  })
})
