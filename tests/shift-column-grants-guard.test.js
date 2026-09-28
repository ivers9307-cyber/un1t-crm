// NOTESGRANT.1 guard (mig 646). `authenticated` holds SELECT on only SOME
// columns of shift_blocks / shift_assignments (tests/helpers/shift-column-grants.js).
// Two ways that can bite later, both pinned here:
//
//  1. Phone-run code (shared/, mobile/) queries these tables with the user's
//     own session. PostgREST refuses the WHOLE select (42501) when it names a
//     column the role cannot read, so one withheld column in the phone's
//     Today query blanks the Today tab. Every select, embed and filter on
//     these tables in shared/ and mobile/ must name granted columns only, and
//     never `*`.
//  2. A migration that ADDS a column to either table leaves it unreadable by
//     authenticated. That must be a decision: the same migration either
//     GRANTs SELECT on it or says `-- column-grant: withheld <table>.<column>`,
//     and the helper's lists gain it.
//
// A floor, not a proof (like check:select-columns): a select string built at
// runtime is invisible here. Server code (src/) is not checked: service_role
// bypasses grants.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SHIFT_COLUMN_GRANTS, SHIFT_GRANT_TABLES, SHIFT_GRANT_MIGRATION } from './helpers/shift-column-grants.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const TABLE_ALT = SHIFT_GRANT_TABLES.join('|')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

/** The text inside the parenthesis that opens at `open` (balanced). */
function balanced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** Top-level column names of a PostgREST select list (embeds skipped). */
function topLevelColumns(list) {
  const cols = []
  let depth = 0
  let cur = ''
  for (const ch of list + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const item = cur.trim()
      cur = ''
      if (!item || item.includes('(') || item.startsWith('${')) continue // embed or interpolation
      const name = item.split(':').pop().split('::')[0].split('->')[0].trim()
      if (name === 'count') continue // PostgREST aggregate: needs no column
      cols.push(name)
    } else cur += ch
  }
  return cols
}

/** Every (table, column) a file's code names on the two shift tables. */
function shiftColumnUses(text) {
  const uses = []
  const selectStrings = [...text.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)]

  // (a) `.from('<table>').select('<list>')` — the top-level list.
  for (const m of text.matchAll(new RegExp(`\\.from\\(\\s*['"\`](${TABLE_ALT})['"\`]\\s*\\)`, 'g'))) {
    const sel = selectStrings.find((s) => s.index > m.index && s.index - m.index < 400)
    if (sel) for (const c of topLevelColumns(sel[2])) uses.push([m[1], c])
    // Filters/orders on the chain, up to the next statement boundary.
    const tail = text.slice(m.index, m.index + 1200)
    const end = tail.search(/\n\s*\n|\bawait\b|;|\]\)/)
    const chain = end > 0 ? tail.slice(0, end) : tail
    for (const f of chain.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|in|is|like|ilike|contains|order|not|filter)\(\s*['"`]([a-z_]+)['"`]/g)) {
      uses.push([m[1], f[1]])
    }
    // Chained filters on the variable after the statement (`q = q.eq('col')`).
    for (const f of text.slice(m.index, m.index + 1200).matchAll(/\bq = q\.(?:eq|neq|gt|gte|lt|lte|in|is)\(\s*['"`]([a-z_]+)['"`]/g)) {
      uses.push([m[1], f[1]])
    }
  }

  // (b) Embeds anywhere in a select: `[alias:]<table>[!hint] ( … )`.
  for (const s of selectStrings) {
    const list = s[2]
    // Lookbehind, not a consumed prefix: a nested embed starts right after
    // its parent's '(' (`a:shift_assignments!fk(shift_blocks!fk(…))`).
    for (const e of list.matchAll(new RegExp(`(?<=^|[\\s,(:])(${TABLE_ALT})(?:![a-z_]+)?\\s*\\(`, 'g'))) {
      const inner = balanced(list, e.index + e[0].length - 1)
      if (inner != null) for (const c of topLevelColumns(inner)) uses.push([e[1], c])
    }
  }

  // (c) Dotted filters: `.eq('shift_blocks.block_date', …)`.
  for (const f of text.matchAll(new RegExp(`['"\`](${TABLE_ALT})\\.([a-z_]+)['"\`]`, 'g'))) uses.push([f[1], f[2]])
  return uses
}

describe('phone-run code names only granted shift columns (NOTESGRANT.1)', () => {
  const files = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]

  it('finds the phone reads it is meant to police (not vacuous)', () => {
    const dashboard = readFileSync(path.join(ROOT, 'shared/dashboard-data.js'), 'utf8')
    const uses = shiftColumnUses(dashboard).map(([t, c]) => `${t}.${c}`)
    expect(uses).toEqual(expect.arrayContaining([
      'shift_assignments.start_time_override', 'shift_assignments.profile_id',
      'shift_blocks.briefing', 'shift_blocks.block_date', 'shift_blocks.location_id',
    ]))
    // The own-swaps list nests shift_blocks inside a shift_assignments embed.
    expect(uses.filter((u) => u === 'shift_blocks.end_time')).toHaveLength(2)
  })

  it('every select, embed and filter on shift_blocks / shift_assignments is granted', () => {
    const offenders = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [table, col] of shiftColumnUses(text)) {
        if (col === '*' || !SHIFT_COLUMN_GRANTS[table].granted.includes(col)) {
          offenders.push(`${path.relative(ROOT, file)}: ${table}.${col}`)
        }
      }
    }
    expect(offenders, 'read these through a service-role /api route, or grant the column in a migration').toEqual([])
  })

  it('the detector catches a withheld column, `*` and a dotted filter', () => {
    const bad = `
      const { data } = await supabase.from('shift_assignments').select('id, partial_reason, shift_blocks!inner ( id, notes )')
      const x = await supabase.from('shift_blocks').select('*').eq('min_coaches', 2)
      q = q.eq('shift_blocks.max_coaches', 3)
      const y = await supabase.from('shift_swap_requests').select('id, requester_shift:shift_assignments!requester_shift_id(arrived_at, shift_blocks!block_id(created_by))')`
    const found = shiftColumnUses(bad).map(([t, c]) => `${t}.${c}`)
    expect(found).toEqual(expect.arrayContaining([
      'shift_assignments.partial_reason', 'shift_blocks.notes', 'shift_blocks.*',
      'shift_blocks.min_coaches', 'shift_blocks.max_coaches', 'shift_assignments.arrived_at',
      'shift_blocks.created_by',
    ]))
  })
})

describe('a new column on a shift table is granted or withheld on purpose', () => {
  const dir = path.join(ROOT, 'supabase/migrations')
  const later = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && parseInt(f, 10) > SHIFT_GRANT_MIGRATION)

  const addedColumns = (sql) => [...sql.matchAll(new RegExp(
    `alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?(?:public\\.)?(${TABLE_ALT})\\b([\\s\\S]*?);`, 'gi'))]
    .flatMap((m) => [...m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?/gi)].map((c) => [m[1].toLowerCase(), c[1]]))

  const decided = (sql, table, col) =>
    new RegExp(`grant\\s+select\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s*on\\s+(?:table\\s+)?(?:public\\.)?${table}\\s+to\\s+authenticated`, 'i').test(sql)
    || new RegExp(`--\\s*column-grant:\\s*withheld\\s+${table}\\.${col}\\b`, 'i').test(sql)

  it.each(later.length ? later : ['(none yet)'])('%s', (file) => {
    if (file === '(none yet)') return
    const sql = readFileSync(path.join(dir, file), 'utf8')
    for (const [table, col] of addedColumns(sql)) {
      expect(decided(sql, table, col), `${file} adds ${table}.${col}: GRANT SELECT (${col}) ON public.${table} TO authenticated, or say "-- column-grant: withheld ${table}.${col}"`).toBe(true)
      const { granted, withheld } = SHIFT_COLUMN_GRANTS[table]
      expect([...granted, ...withheld], `add ${col} to tests/helpers/shift-column-grants.js`).toContain(col)
    }
  })

  it('the detector sees an ALTER … ADD COLUMN and both ways of deciding it', () => {
    const sql = `ALTER TABLE public.shift_blocks ADD COLUMN IF NOT EXISTS colour text, ADD COLUMN level int;`
    expect(addedColumns(sql)).toEqual([['shift_blocks', 'colour'], ['shift_blocks', 'level']])
    expect(decided(`GRANT SELECT (colour) ON public.shift_blocks TO authenticated;`, 'shift_blocks', 'colour')).toBe(true)
    expect(decided(`-- column-grant: withheld shift_blocks.level`, 'shift_blocks', 'level')).toBe(true)
    expect(decided(sql, 'shift_blocks', 'colour')).toBe(false)
  })
})
