// PASSCODEREAD.1/.2 guard (migs 651, 652). Glofox member passwords are never
// stored: contacts.glofox_passcode and glofox_push_events.passcode_sent were
// CHECK-constrained NULL (651) and then DROPPED (652); glofox_push_events
// holds no client grant. Four ways that could come back, all pinned here:
//
//  (a) app code names either column again (a write fails at the CHECK — a
//      created-but-unlinked Glofox member — and a read keeps the column alive
//      past its drop). The retired merge-tag literal '{{glofox_passcode}}' is
//      allowed: it always renders empty (src/lib/postmark.js).
//  (b) client-run code (shared/, mobile/, any src file that is 'use client'
//      or builds the browser client) reads glofox_push_events: it has no grant,
//      so PostgREST answers 42501 and the screen breaks.
//  (c) a migration after 651 grants anything on glofox_push_events to a
//      client role, by name or through ALL TABLES IN SCHEMA public.
//  (d) a migration after 651 drops a *_passcode_retired CHECK without
//      dropping its column in the same file (the only legitimate reason).
//  (e) the columns do not exist: the migration replay check:select-columns
//      uses (scripts/check-select-columns.mjs) must not have either column,
//      nor contact_location_audience.glofox_passcode, so a later ADD COLUMN
//      or a view that selects it fails here.
//
// A floor, not a proof: a column name assembled at runtime is invisible here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { collectSchema, applyMigrationSql } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PASSCODE_RETIRE_MIGRATION = 651

const PASSCODE_RETIRE_FILE = '651_retire_glofox_passcodes.sql'
const PASSCODE_DROP_FILE = '652_drop_glofox_passcode_columns.sql'

/** The retired passcode columns present in a replayed schema (Map<table, Set<column>>). */
export function retiredColumnsPresent(schema) {
  const out = []
  if (schema.get('contacts')?.has('glofox_passcode')) out.push('contacts.glofox_passcode')
  if (schema.get('glofox_push_events')?.has('passcode_sent')) out.push('glofox_push_events.passcode_sent')
  if (schema.get('contact_location_audience')?.has('glofox_passcode')) out.push('contact_location_audience.glofox_passcode')
  return out
}

/**
 * A migration that can run after 651: a numeric prefix >= 651, except the 651
 * file itself (by exact name). A plain `> 651` skipped `651b_*.sql` and a
 * duplicate-prefix `651_*.sql` from another branch (duplicates are allowed).
 */
const isLaterMigration = (f) =>
  f.endsWith('.sql') && f !== PASSCODE_RETIRE_FILE && parseInt(f, 10) >= PASSCODE_RETIRE_MIGRATION

// (a) and (b) walk the whole repo, which outruns vitest's 5s default on a
// loaded machine; the same budget as the other whole-repo guards.
const WHOLE_REPO_TIMEOUT_MS = 120_000

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** Block comments, and line comments that start a line or follow whitespace (keeps `https://`). */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1')

/** Every mention of a retired column in code (comments ignored; the retired tag literal allowed). */
function retiredColumnUses(text) {
  const code = stripComments(text)
  return [
    ...[...code.matchAll(/(?<!\{\{)\bglofox_passcode\b/g)].map(() => 'glofox_passcode'),
    ...[...code.matchAll(/\bpasscode_sent\b/g)].map(() => 'passcode_sent'),
  ]
}

const isClientRun = (rel, text) =>
  rel.startsWith('shared/') || rel.startsWith('mobile/')
  || /^\s*['"]use client['"]/m.test(text) || /\bcreateBrowserClient\b/.test(text)

describe('(a) no app code names a retired passcode column', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const files = ['src', 'shared', 'mobile', 'scripts', 'supabase/functions'].flatMap((d) => walk(path.join(ROOT, d)))

  it('scans a real tree (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.endsWith(path.join('src', 'lib', 'glofox-push.js')))).toBe(true)
  })

  it('finds none', () => {
    const offenders = []
    for (const file of files) {
      for (const col of retiredColumnUses(readFileSync(file, 'utf8'))) offenders.push(`${path.relative(ROOT, file)}: ${col}`)
    }
    expect(offenders, 'Glofox passwords are not stored; these columns were dropped (PASSCODEREAD.1/.2, migs 651/652)').toEqual([])
  })

  it('the detector catches writes and selects, and ignores comments and the retired tag', () => {
    const bad = `
      await db.from('contacts').update({ glofox_member_id: id, glofox_passcode: pc })
      await db.from('glofox_push_events').insert({ ...row, passcode_sent })
      const q = db.from('glofox_push_events').select('id, passcode_sent')`
    expect(retiredColumnUses(bad).sort()).toEqual(['glofox_passcode', 'passcode_sent', 'passcode_sent'])
    const ok = `
      // contacts.glofox_passcode used to hold it (comment)
      /* passcode_sent too */
      const replacements = { '{{glofox_passcode}}': '' }
      const url = 'https://example.test/x'`
    expect(retiredColumnUses(ok)).toEqual([])
  })
})

describe('(b) client-run code never reads glofox_push_events (it has no client grant)', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  it('finds none', () => {
    const offenders = []
    for (const file of ['src', 'shared', 'mobile'].flatMap((d) => walk(path.join(ROOT, d)))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      const text = readFileSync(file, 'utf8')
      if (isClientRun(rel, text) && /\bglofox_push_events\b/.test(stripComments(text))) offenders.push(rel)
    }
    expect(offenders, 'read it through a service-role /api route (see /api/admin/glofox-push-events)').toEqual([])
  })

  it('the Review tab is client-run and reaches the table only through the admin API', () => {
    const rel = 'src/components/GlofoxPushReviewTab.jsx'
    const text = readFileSync(path.join(ROOT, rel), 'utf8')
    expect(isClientRun(rel, text)).toBe(true)
    expect(text).toContain("fetch('/api/admin/glofox-push-events")
  })
})

/** A SQL identifier without quotes, lowercased. */
const ident = (s) => s.trim().replace(/["']/g, '').toLowerCase()

function splitTop(list) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** GRANTs in `sql` that give a client role ANY privilege on glofox_push_events. */
function pushEventClientGrants(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, , target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => ['authenticated', 'anon', 'public'].includes(g))) continue
    const all = target.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) {
      if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim())
      continue
    }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map((t) => ident(t).replace(/^public\./, ''))
    if (tables.includes('glofox_push_events')) hits.push(stmt.trim())
  }
  return hits
}

describe('(c)(d) later migrations keep the passcode retired', () => {
  const dir = path.join(ROOT, 'supabase/migrations')
  const later = readdirSync(dir).filter(isLaterMigration)
  const cases = later.length ? later : ['(none yet)']

  it('counts a same-number-suffixed or duplicate-prefix 651 as later, and skips only 651 itself', () => {
    expect(existsSync(path.join(dir, PASSCODE_RETIRE_FILE))).toBe(true)
    expect(isLaterMigration(PASSCODE_RETIRE_FILE)).toBe(false)
    expect(isLaterMigration('651b_regrant.sql')).toBe(true)
    expect(isLaterMigration('651_another_branch.sql')).toBe(true)
    expect(isLaterMigration('652_drop_passcode_columns.sql')).toBe(true)
    expect(isLaterMigration('1000_future.sql')).toBe(true)
    expect(isLaterMigration('650_earlier.sql')).toBe(false)
    expect(isLaterMigration('652_notes.md')).toBe(false)
  })

  it.each(cases)('%s grants nothing on glofox_push_events to a client role', (file) => {
    if (file === '(none yet)') return
    const sql = readFileSync(path.join(dir, file), 'utf8')
    expect(pushEventClientGrants(sql), `${file}: glofox_push_events is server-only (mig 651)`).toEqual([])
  })

  it.each(cases)('%s drops a *_passcode_retired CHECK only together with its column', (file) => {
    if (file === '(none yet)') return
    const sql = readFileSync(path.join(dir, file), 'utf8').replace(/--[^\n]*/g, ' ')
    if (/drop\s+constraint\s+(if\s+exists\s+)?"?contacts_glofox_passcode_retired/i.test(sql)) {
      expect(sql, `${file}: drop contacts.glofox_passcode in the same file`).toMatch(/drop\s+column\s+(if\s+exists\s+)?"?glofox_passcode\b/i)
    }
    if (/drop\s+constraint\s+(if\s+exists\s+)?"?glofox_push_events_passcode_retired/i.test(sql)) {
      expect(sql, `${file}: drop glofox_push_events.passcode_sent in the same file`).toMatch(/drop\s+column\s+(if\s+exists\s+)?"?passcode_sent\b/i)
    }
  })

  it('the grant detector catches every re-grant form and ignores the rest', () => {
    const bad = [
      'GRANT SELECT ON public.glofox_push_events TO authenticated;',
      'grant all on table glofox_push_events to anon;',
      'GRANT SELECT (id, status) ON "public"."glofox_push_events" TO "authenticated";',
      'GRANT INSERT ON public.contacts, public.glofox_push_events TO service_role, PUBLIC;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.glofox_push_events TO authenticated'; END $$;`,
    ]
    for (const sql of bad) expect(pushEventClientGrants(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT ON public.glofox_push_events TO service_role;',
      'GRANT SELECT ON public.glofox_push_events_archive TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
      '-- GRANT ALL ON public.glofox_push_events TO anon, authenticated;  (rollback note)',
      'GRANT EXECUTE ON FUNCTION public.glofox_push_events_x() TO authenticated;',
    ]
    for (const sql of ok) expect(pushEventClientGrants(sql), sql).toEqual([])
  })
})

describe('(e) the retired columns no longer exist (mig 652)', () => {
  const dir = path.join(ROOT, 'supabase/migrations')
  const { schema, skippedViews } = collectSchema(dir)

  it('mig 652 is present', () => {
    expect(existsSync(path.join(dir, PASSCODE_DROP_FILE))).toBe(true)
  })

  it('the replay knows all three relations (not vacuous)', () => {
    expect(schema.has('contacts')).toBe(true)
    expect(schema.has('glofox_push_events')).toBe(true)
    expect(schema.has('contact_location_audience')).toBe(true)
    expect(skippedViews.has('contact_location_audience')).toBe(false)
    expect(schema.get('contact_location_audience').has('audience_location_id')).toBe(true)
  })

  it('no migration leaves or brings back a retired column', () => {
    expect(retiredColumnsPresent(schema), 'the passcode columns were dropped by mig 652; do not re-add them').toEqual([])
  })

  it('the detector sees a re-add and a view that selects it', () => {
    const s = new Map([['contacts', new Set(['id', 'location_id'])], ['glofox_push_events', new Set(['id'])]])
    applyMigrationSql('ALTER TABLE public.contacts ADD COLUMN glofox_passcode text;', s)
    applyMigrationSql('ALTER TABLE public.glofox_push_events ADD COLUMN IF NOT EXISTS passcode_sent text;', s)
    applyMigrationSql('CREATE VIEW public.contact_location_audience AS SELECT c.id, c.glofox_passcode FROM public.contacts c;', s)
    expect(retiredColumnsPresent(s)).toEqual([
      'contacts.glofox_passcode', 'glofox_push_events.passcode_sent', 'contact_location_audience.glofox_passcode',
    ])
  })
})
