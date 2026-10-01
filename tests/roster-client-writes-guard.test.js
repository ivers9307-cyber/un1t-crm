// ROSTERCLIENTWRITE.1 guard (mig 679). No client role writes public.rosters
// or public.shift_templates: authenticated holds only mig 618's column SELECT
// list on rosters and table-level SELECT on shift_templates, anon and PUBLIC
// nothing, and each table has exactly one policy, its SELECT policy. Pinned
// here:
//
//  1. Client-run code (shared/, mobile/, desktop/, and every src/ file that
//     is 'use client' after any header comment, names createBrowserClient,
//     calls createAuthClient() or holds the anon key) never INSERTs,
//     UPDATEs, UPSERTs or DELETEs either table through PostgREST, and never
//     names a raw /rest/v1/rosters or /rest/v1/shift_templates URL. Any such
//     write is a 42501 after 679. Publish, approve, reject and edit templates
//     through the service-role /api/schedule/rosters* and
//     /api/schedule/templates* routes.
//  2. A later migration may not give a client role back a write, or reopen
//     rosters' withheld columns: any privilege at all to anon or PUBLIC on
//     the two tables; to authenticated, on rosters anything but a
//     column-list SELECT (mig 618's shape: a table-level SELECT would reopen
//     the budget columns), on shift_templates anything but SELECT; any client
//     grant ON ALL TABLES IN SCHEMA public; any GRANT <role> TO a client
//     role; a policy on either table that is not FOR SELECT (no FOR means
//     ALL); DISABLE ROW LEVEL SECURITY or OWNER TO a client role on either; a
//     CREATE TABLE, CREATE VIEW or RENAME TO either name (the default ACL
//     re-grants ALL); any non-temp view (plain, materialized or recursive,
//     security_invoker or not) whose definition names either table. A GRANT
//     run from EXECUTE '…' or $q$…$q$ counts. The one exemption is a
//     rollback migration named `<NNN>_rosterclientwrite1_rollback.sql`.
//
// Code is read with tests/helpers/js-code.js codeOf (comments, JSX text and
// regex literals blanked by the TypeScript parser) and SQL with
// tests/helpers/sql-code.js sqlCode (one quote-aware, $tag$-pairing pass;
// GUARDSTRIP.1). isClientCode is the same test as
// tests/shift-client-writes-guard.test.js. A floor, not a proof: `.from(<variable>)`, a chain
// split across statements and SQL built at runtime are invisible. Server
// code is not checked: service_role bypasses grants. No other repo on this
// project names either table (C110 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'
import { columnUses, fkAliasesInto } from './helpers/postgrest-column-uses.js'
import { collectSchema } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const CLOSED_MIGRATION = 679
// Scanned from 631, not 679: numbers are reserved ahead of time and a lower
// one can merge later (631 is the HELD #1774). 631-678 hold nothing the
// detector flags (they only revoke on these two tables, or do not name them).
const SCAN_FROM = 631
const TABLES = ['rosters', 'shift_templates']
// What authenticated may still be GRANTed per table (679's end state).
const AUTH_MAY = {
  rosters: (p) => /^select\s*\([^)]*\)$/i.test(p.trim()),            // column-list SELECT only (mig 618)
  shift_templates: (p) => /^select(\s*\([^)]*\))?$/i.test(p.trim()), // SELECT, table or column level
}
const FK_ALIASES = fkAliasesInto(collectSchema(MIG_DIR).fks, TABLES)
const ROLLBACK_FILE = /^\d+_rosterclientwrite1_rollback\.sql$/
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// ── client code ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}

let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = ['shared', 'mobile', 'desktop'].flatMap((d) => walk(path.join(ROOT, d)))
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f).trimStart()))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

/** PostgREST reads/writes on the two tables in one file's code. */
export const scanUses = (text) => columnUses(text, TABLES, FK_ALIASES)
const USES = new Map()
const usesOf = (f) => {
  if (!USES.has(f)) USES.set(f, columnUses(readFileSync(f, 'utf8'), TABLES, FK_ALIASES))
  return USES.get(f)
}
const RAW_URL = /\/rest\/v1\/(rosters|shift_templates)\b/

describe('client code never writes rosters or shift_templates (ROSTERCLIENTWRITE.1)', { timeout: 120_000 }, () => {
  const files = clientFiles()

  it('scans the client files and finds the phone reads (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toContain('shared/dashboard-data.js')
    expect(names.some((f) => f.startsWith('mobile/app/'))).toBe(true)
    const reads = usesOf(path.join(ROOT, 'shared/dashboard-data.js')).reads.map(([t, c]) => `${t}.${c}`)
    expect(reads).toEqual(expect.arrayContaining(['rosters.status', 'shift_templates.name', 'shift_templates.start_time']))
  })

  it('no INSERT, UPDATE, UPSERT or DELETE on either table from a browser or phone', () => {
    const offenders = []
    for (const f of files) for (const [t, op] of usesOf(f).writes) offenders.push(`${rel(f)}: ${op} on ${t}`)
    expect(offenders, 'write through a service-role /api/schedule route (mig 679 grants no client write)').toEqual([])
  })

  it('no raw /rest/v1/rosters or /rest/v1/shift_templates URL in client code', () => {
    const offenders = files.filter((f) => RAW_URL.test(codeOfFile(f))).map(rel)
    expect(offenders).toEqual([])
  })

  it('the scanner sees the write forms it must, and passes reads', () => {
    expect(scanUses(`db.from('rosters').update({ status: 'published' }).eq('id', i)`).writes).toEqual([['rosters', 'update']])
    expect(scanUses(`db.from('shift_templates').insert(row)`).writes).toEqual([['shift_templates', 'insert']])
    expect(scanUses(`db.from("shift_templates").upsert(rows)`).writes).toEqual([['shift_templates', 'upsert']])
    expect(scanUses(`db.from('rosters').delete().eq('id', i)`).writes).toEqual([['rosters', 'delete']])
    expect(scanUses(`db.from('rosters').select('id, status').eq('location_id', l)`).writes).toEqual([])
    expect(scanUses(`// db.from('rosters').delete()\n/* db.from('shift_templates').insert({}) */\n`).writes).toEqual([])
    expect(isClientCode("'use client'\nexport const x = 1")).toBe(true)
    expect(isClientCode("import { createServerClient } from '@/lib/supabase'")).toBe(false)
  })
})

// ── migrations ───────────────────────────────────────────────────────────

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
const tableName = (t) => ident(t).replace(/\s+/g, '').replace(/^public\./, '')
const CLIENT = ['authenticated', 'anon', 'public']
const NOT_A_TABLE = /^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all)\s/i

/** Every statement in `sql` that gives a client role a write (or rosters' withheld columns) on the two tables. */
export function rosterWriteReopeners(sql) {
  const code = sqlCode(sql)
  const hits = []
  // Each part stops at ; ' or $, so a GRANT run from EXECUTE '…' or
  // EXECUTE $q$…$q$ ends at its quote.
  for (const m of code.matchAll(/\bgrant\s+([^;'$]+?)\s+on\s+([^;'$]+?)\s+to\s+([^;'$]+?)(?:;|'|\$|$)/gi)) {
    const [stmt, privs, target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT.includes(g))) continue
    const all = target.trim().match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (NOT_A_TABLE.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map(tableName).filter((t) => TABLES.includes(t))
    if (!tables.length) continue
    if (grantees.some((g) => g === 'anon' || g === 'public')) { hits.push(stmt.trim()); continue }
    // authenticated: only what 679 leaves it (AUTH_MAY), on every table named.
    if (!tables.every((t) => splitTop(privs).every(AUTH_MAY[t]))) hits.push(stmt.trim())
  }
  // Role membership: a client role that inherits another role gets every
  // privilege that role holds, on these tables too.
  for (const m of code.matchAll(/\bgrant\s+([^;'$]+?)\s+to\s+([^;'$]+?)(?:;|'|\$|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(roles)) continue
    const grantees = splitTop(to.replace(/\s+(with\s+\w+\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT.includes(g))) hits.push(stmt.trim())
  }
  const policyRe = /\bcreate\s+policy\s+(?:"[^"]*"|[a-z_][a-z0-9_]*)\s+on\s+(?:table\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;]*)/gi
  for (const m of code.matchAll(policyRe)) {
    const cmd = (m[2].match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] || 'all').toLowerCase()
    if (TABLES.includes(tableName(m[1])) && cmd !== 'select') hits.push(m[0].trim())
  }
  const alterRe = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;'$]*)/gi
  for (const m of code.matchAll(alterRe)) {
    const t = tableName(m[1])
    const rest = m[2]
    const rename = rest.match(/\brename\s+to\s+"?([a-z_][a-z0-9_]*)"?/i)
    if (rename && TABLES.includes(rename[1].toLowerCase())) { hits.push(m[0].trim()); continue }
    if (!TABLES.includes(t)) continue
    if (/\bdisable\s+row\s+level\s+security\b/i.test(rest)) hits.push(m[0].trim())
    const owner = rest.match(/\bowner\s+to\s+"?([a-z_][a-z0-9_]*)"?/i)
    if (owner && CLIENT.includes(owner[1].toLowerCase())) hits.push(m[0].trim())
  }
  const createRe = /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$."])/gi
  for (const m of code.matchAll(createRe)) if (TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
  // Views (the mig 676 guard's shapes). A view created under either name, or
  // renamed to it, gets the default ACL. A view OVER either table is flagged
  // whatever its options: owned by postgres, a simple one is auto-updatable
  // and reads and writes the table as its owner, past RLS, mig 618's column
  // list and 679's REVOKE (a materialized one still leaks the budget
  // columns). A TEMP view is session-local and never reaches PostgREST.
  const viewRe = /\bcreate\s+(?:or\s+replace\s+)?(temp(?:orary)?\s+)?(?:(?:materialized|recursive)\s+)*view\s+(?:if\s+not\s+exists\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;]*)/gi
  const namesRosterTable = /(?<![a-z0-9_$".])(?:"?public"?\s*\.\s*)?"?(?:rosters|shift_templates)"?(?![a-z0-9_$])/i
  for (const m of code.matchAll(viewRe)) {
    if (m[1]) continue
    const name = m[2].replace(/["\s]/g, '').toLowerCase().replace(/^public\./, '')
    if (TABLES.includes(name) || namesRosterTable.test(m[3])) hits.push(m[0].trim())
  }
  const alterViewRe = /\balter\s+(?:materialized\s+)?view\s+[^;]*?\brename\s+to\s+"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$])/gi
  for (const m of code.matchAll(alterViewRe)) if (TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
  return hits
}

describe('later migrations keep rosters and shift_templates write-closed (ROSTERCLIENTWRITE.1)', () => {
  const all = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f))
  const scanned = all.filter((f) => Number.parseInt(f, 10) >= SCAN_FROM && Number.parseInt(f, 10) !== CLOSED_MIGRATION)

  it('mig 679 is on disk and reopens nothing', () => {
    const file = all.find((f) => Number.parseInt(f, 10) === CLOSED_MIGRATION && /rosters_shift_templates_client_writes_off/.test(f))
    expect(file).toBe('679_rosters_shift_templates_client_writes_off.sql')
    expect(rosterWriteReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8'))).toEqual([])
  })

  it('the scan covers 646, 668 and 676 (not vacuous)', () => {
    expect(scanned).toEqual(expect.arrayContaining(['646_shift_notes_column_grants.sql',
      '668_scheduling_tables_client_grants.sql', '676_shift_tables_client_writes_off.sql']))
  })

  it.each(scanned)('%s gives no client role a write on rosters or shift_templates', (file) => {
    if (ROLLBACK_FILE.test(file) && Number.parseInt(file, 10) > CLOSED_MIGRATION) return
    expect(rosterWriteReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: this gives a browser or phone a write on rosters/shift_templates again, or reopens rosters' withheld columns (migs 618, 679). Write through a service-role /api/schedule route`).toEqual([])
  })

  it('a ROSTERCLIENTWRITE.1 rollback migration is allow-listed by its file name, and nothing else is', () => {
    const exempt = (f) => ROLLBACK_FILE.test(f) && Number.parseInt(f, 10) > CLOSED_MIGRATION
    expect(exempt('680_rosterclientwrite1_rollback.sql')).toBe(true)
    for (const name of ['680_restore_roster_writes.sql', '680_rosterclientwrite1_rollback_and_more.sql',
      'rosterclientwrite1_rollback.sql', '678_rosterclientwrite1_rollback.sql', '680_rosterclientwrite1_rollback.sql.bak',
      '680_shiftclientwrite1_rollback.sql']) {
      expect(exempt(name), name).toBe(false)
    }
  })

  it.each([
    'GRANT INSERT, UPDATE, DELETE ON public.rosters, public.shift_templates TO authenticated;',
    'GRANT UPDATE ON public.rosters TO authenticated;',
    'GRANT UPDATE (status) ON public.rosters TO authenticated;',
    'GRANT SELECT (id), INSERT (id) ON public.rosters TO authenticated;',
    // a table-level SELECT on rosters reopens 618's withheld budget columns
    'GRANT SELECT ON public.rosters TO authenticated;',
    'GRANT SELECT ON public.rosters, public.shift_templates TO authenticated;',
    'GRANT ALL ON "public"."shift_templates" TO "authenticated" WITH GRANT OPTION;',
    'grant delete on table shift_templates to authenticated;',
    'GRANT SELECT, INSERT ON public.shift_templates TO authenticated;',
    'GRANT UPDATE (name) ON public.shift_templates TO authenticated;',
    'GRANT SELECT ON public.shift_templates TO anon;',
    'GRANT SELECT (id) ON public.rosters TO anon;',
    'GRANT REFERENCES ON public.rosters TO PUBLIC;',
    'GRANT INSERT ON ALL TABLES IN SCHEMA public TO authenticated;',
    `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.rosters TO authenticated'; END $$;`,
    `DO $$ BEGIN EXECUTE $q$GRANT DELETE ON public.shift_templates TO authenticated$q$; END $$;`,
    'GRANT sneaky TO authenticated;',
    'CREATE POLICY rosters_upd ON public.rosters FOR UPDATE TO authenticated USING (true);',
    'CREATE POLICY "p" ON shift_templates TO authenticated USING (true);',
    'CREATE POLICY p ON public.shift_templates FOR INSERT TO authenticated WITH CHECK (true);',
    'ALTER TABLE public.rosters DISABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.shift_templates OWNER TO authenticated;',
    'ALTER TABLE public.rosters_new RENAME TO rosters;',
    'CREATE TABLE IF NOT EXISTS public.shift_templates (id uuid);',
    // A view under either name, or renamed to it, gets the default ACL (ALL).
    'CREATE VIEW public.rosters AS SELECT 1 AS id;',
    'CREATE OR REPLACE VIEW "public"."shift_templates" AS SELECT 1 AS id;',
    'ALTER VIEW public.my_rosters RENAME TO rosters;',
    'ALTER MATERIALIZED VIEW IF EXISTS public.tpl RENAME TO "shift_templates";',
    // A view over either table: postgres-owned, auto-updatable, past RLS, 618 and 679.
    'CREATE VIEW public.roster_status AS SELECT id, status FROM public.rosters;',
    'CREATE OR REPLACE VIEW public.v WITH (security_invoker = on) AS SELECT t.id FROM public.shift_templates t;',
    'CREATE MATERIALIZED VIEW public.roster_mv AS SELECT * FROM "public"."rosters";',
    'CREATE VIEW public.v AS SELECT b.id FROM public.shift_blocks b JOIN rosters r ON r.id = b.roster_id;',
    'create recursive view public.v (id) as select id from public.shift_templates;',
    // The rollback record reopens the writes: that is why it needs the name exemption.
    'GRANT INSERT, UPDATE, DELETE ON public.rosters, public.shift_templates TO authenticated;\nCREATE POLICY "rosters_ins" ON public.rosters FOR INSERT TO authenticated WITH CHECK (true);',
  ])('the detector flags %s', (sql) => {
    expect(rosterWriteReopeners(sql)).not.toEqual([])
  })

  it.each([
    'GRANT SELECT (id, location_id, period_start, period_end, status) ON public.rosters TO authenticated;',
    'GRANT SELECT (requested_period_start) ON public.rosters TO authenticated;',
    'GRANT SELECT ON public.shift_templates TO authenticated;',
    'GRANT SELECT (id, name) ON public.shift_templates TO authenticated;',
    'GRANT ALL ON public.rosters, public.shift_templates TO service_role;',
    'GRANT UPDATE ON public.shift_template_qualification_requirements TO authenticated;',
    'GRANT UPDATE ON public.roster_publish_snapshots TO authenticated;',
    'GRANT UPDATE ON public.shift_blocks TO authenticated;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
    'GRANT EXECUTE ON FUNCTION public.rosters_x() TO authenticated;',
    'GRANT USAGE ON SCHEMA public TO authenticated;',
    'GRANT authenticated TO some_role;',
    'REVOKE INSERT, UPDATE, DELETE ON public.rosters, public.shift_templates FROM authenticated;',
    'REVOKE ALL ON public.rosters, public.shift_templates FROM anon, PUBLIC;',
    'CREATE POLICY rosters_select ON public.rosters FOR SELECT TO authenticated USING (true);',
    'CREATE POLICY p ON public.roster_change_log FOR UPDATE TO authenticated USING (true);',
    'ALTER TABLE public.rosters ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.shift_templates ADD COLUMN colour text;',
    'ALTER TABLE public.rosters RENAME TO rosters_old;',
    'CREATE TABLE public.rosters_archive (id uuid);',
    'CREATE TABLE public.shift_template_tags (id uuid);',
    'CREATE VIEW public.rosters_summary AS SELECT 1 AS n;',
    'CREATE VIEW public.v AS SELECT * FROM public.rosters_archive;',
    'CREATE VIEW public.v AS SELECT id, rosters_count FROM public.locations;',
    'CREATE VIEW public.v AS SELECT * FROM public.roster_change_log;',
    'ALTER VIEW public.rosters_v RENAME TO rosters_old;',
    'CREATE TEMP VIEW t AS SELECT * FROM public.rosters;',
    'DROP VIEW IF EXISTS public.my_rosters;',
    'CREATE INDEX ON public.rosters (status);',
    '-- GRANT UPDATE ON public.rosters TO authenticated;',
    '/* GRANT ALL ON public.shift_templates TO anon; */',
  ])('the detector passes %s', (sql) => {
    expect(rosterWriteReopeners(sql)).toEqual([])
  })

  it.each([
    ['a /* inside a string before a real grant', "SELECT '/* not a comment';\nGRANT UPDATE ON public.rosters TO authenticated;"],
    ['a /* inside a -- comment before a real grant', '-- see migrations/*.sql\nGRANT DELETE ON public.shift_templates TO authenticated;\n/* x */'],
    ['a /* inside a $$ string after a DO block', [
      'DO $$ BEGIN NULL; END $$;',
      'COMMENT ON TABLE public.rosters IS $$ see /* $$;',
      'GRANT INSERT ON public.shift_templates TO authenticated;',
      'COMMENT ON TABLE public.rosters IS $$ */ $$;',
    ].join('\n')],
  ])('comments cannot hide a reopener: %s', (_, sql) => {
    expect(rosterWriteReopeners(sql)).not.toEqual([])
  })
})
