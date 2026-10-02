// GUARDSTRIP.1 (C74; C89's review) — the estate-wide ways around a closed
// table. Each per-table guard (646 shift columns … 684 member-write sweep)
// checks that no later migration GRANTs its tables back to a client role. None
// of them sees a client getting at the same rows WITHOUT naming the table in a
// GRANT. Checked here once, for every table in CLOSED_TABLES
// (tests/helpers/sql-escapes.js):
//
//  1. Views. A simple view runs as its owner (postgres) and is auto-updatable,
//     so a client privilege on a definer view over a closed table reads and
//     PATCHes the rows past both the REVOKE and RLS. Every view in public, at
//     the end of the migration replay, is security_invoker and not
//     materialized (DEFINER_VIEWS_ALLOWED is empty).
//  2. Functions. A SECURITY DEFINER function runs as postgres too. No public
//     function a client may execute (CLIENT_RPCS, plus any GRANT EXECUTE to a
//     client role after mig 667 closed the rest) is a definer that writes a
//     closed table.
//  3. Roles and names, from SCAN_FROM (the first closing migration) on: no
//     role membership into or out of a client role (Supabase's own
//     authenticator excepted), no ALTER … OWNER TO a client role, no
//     relation moved into public (it keeps its own ACL), no relation renamed
//     to a closed table's name. (tests/table-default-acl-guard.test.js holds
//     every migration from 676 to the first two rules for every relation.)
//  4. CLOSED_TABLES knows every table a per-table guard closes.
//
// SQL is read through tests/helpers/sql-code.js (comments blanked by a
// quote-aware, $tag$-pairing scan, never a regex). A floor, not a proof: SQL
// built at runtime (EXECUTE format(…)), an old-style '…'-quoted function body
// and anything done by hand on prod are invisible; each closing migration's
// self-check covers the live catalog at apply time.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CLOSED_TABLES, roleLeaks, movedInto, viewReplay, functionReplay, clientExecuteGrants, relationsRead, tablesWritten,
} from './helpers/sql-escapes.js'
import { CLIENT_RPCS } from './helpers/client-rpcs.js'
import { SHIFT_GRANT_TABLES } from './helpers/shift-column-grants.js'
import { SEQUENCE_TABLES } from './helpers/sequence-column-grants.js'
import { CREDENTIAL_GRANT_TABLES } from './helpers/credential-column-grants.js'
import { ANON_NONE_TABLES } from './helpers/scheduling-client-grants.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const SCAN_FROM = Math.min(...Object.values(CLOSED_TABLES)) // 646
const FN_EXECUTE_MIGRATION = 667

/** Views allowed to run as their owner (none: name the view and why it never reaches a client). */
export const DEFINER_VIEWS_ALLOWED = {}
/** DEFINER functions a client may execute that write a closed table (none). */
export const DEFINER_WRITERS_ALLOWED = {}

const migrationFiles = () => readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))
const MIGS = migrationFiles().map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS, file), 'utf8') }))
const closed = Object.keys(CLOSED_TABLES)

describe('no view, function, role or rename reopens a closed table (GUARDSTRIP.1)', { timeout: 120_000 }, () => {
  it('replays the real migrations (not vacuous)', () => {
    expect(MIGS.length).toBeGreaterThan(600)
    const views = viewReplay(MIGS)
    expect(views.get('contact_location_audience')).toMatchObject({ invoker: true, reads: expect.arrayContaining(['contacts']) })
    const fns = functionReplay(MIGS)
    for (const name of CLIENT_RPCS) expect(fns.has(name), name).toBe(true)
    expect(fns.get('handle_new_booking')).toMatchObject({ definer: true, writes: expect.arrayContaining(['contacts']) })
  })

  it('every view in public is security_invoker (a definer view over a closed table bypasses its REVOKE and RLS)', () => {
    const bad = [...viewReplay(MIGS)]
      .filter(([name, v]) => (v.materialized || !v.invoker) && !DEFINER_VIEWS_ALLOWED[name])
      .map(([name, v]) => `${name} (${v.file}${v.materialized ? ', materialized' : ''}; reads ${v.reads.join(', ')})`)
    expect(bad, 'CREATE [OR REPLACE] VIEW public.<v> WITH (security_invoker = on) AS … (restate it on every CREATE OR REPLACE)').toEqual([])
  })

  it('no function a client may execute is a SECURITY DEFINER writer of a closed table', () => {
    const fns = functionReplay(MIGS)
    const executable = new Set(CLIENT_RPCS)
    for (const { file, sql } of MIGS) if (parseInt(file, 10) > FN_EXECUTE_MIGRATION) for (const n of clientExecuteGrants(sql)) executable.add(n)
    const bad = [...executable].filter((n) => !DEFINER_WRITERS_ALLOWED[n]).flatMap((n) => {
      const f = fns.get(n)
      const hit = f?.definer ? f.writes.filter((t) => closed.includes(t)) : []
      return hit.length ? [`${n} (${f.file}) writes ${hit.join(', ')}`] : []
    })
    expect(bad, 'a client-executable DEFINER function runs as postgres: make it SECURITY INVOKER, or move the write behind a service-role route').toEqual([])
  })

  it.each(MIGS.filter((m) => parseInt(m.file, 10) >= SCAN_FROM).map((m) => m.file))('%s: no client role membership or ownership, nothing moved or renamed into a closed name', (file) => {
    const { sql } = MIGS.find((m) => m.file === file)
    expect(roleLeaks(sql), `${file}: clients get named privileges on named objects, never a role or an owner`).toEqual([])
    expect(movedInto(sql), `${file}: a relation moved into public, or renamed to a closed table's name, keeps its own ACL`).toEqual([])
  })
})

describe('CLOSED_TABLES knows every table a per-table guard closes', () => {
  it('every helper list and every TABLES / TABLE / { table: } literal in a client-writes or closed guard', () => {
    const named = new Set([...SHIFT_GRANT_TABLES, ...SEQUENCE_TABLES, ...CREDENTIAL_GRANT_TABLES, ...ANON_NONE_TABLES])
    const guards = readdirSync(path.join(ROOT, 'tests')).filter((f) => /(client-writes|client-closed|member-write).*guard\.test\.js$/.test(f))
    expect(guards.length).toBeGreaterThan(8)
    for (const f of guards) {
      const src = readFileSync(path.join(ROOT, 'tests', f), 'utf8')
      for (const m of src.matchAll(/^const TABLES = \[([^\]]*)\]/gm)) for (const t of m[1].matchAll(/'([a-z_]+)'/g)) named.add(t[1])
      for (const m of src.matchAll(/^const TABLE = '([a-z_]+)'/gm)) named.add(m[1])
      for (const m of src.matchAll(/\{ table: '([a-z_]+)', mig: \d+/g)) named.add(m[1])
    }
    expect([...named].filter((t) => !closed.includes(t)), 'add it to CLOSED_TABLES in tests/helpers/sql-escapes.js with its closing migration').toEqual([])
    expect(named.size).toBeGreaterThan(40)
  })
})

describe('the detectors', () => {
  it('viewReplay: options from each CREATE, ALTER VIEW SET/RESET, rename, drop, a view moved in', () => {
    const views = viewReplay([
      { file: 'a', sql: 'CREATE VIEW public.v1 WITH (security_invoker = on) AS SELECT id FROM public.contacts;\nCREATE VIEW v2 AS SELECT * FROM contacts c JOIN public.consent_log l ON true;' },
      { file: 'b', sql: 'CREATE OR REPLACE VIEW public.v1 AS SELECT id FROM public.contacts;\nALTER VIEW public.v2 SET (security_invoker = true);\nCREATE VIEW public.v3 WITH (security_invoker) AS SELECT 1;' },
      { file: 'c', sql: 'ALTER VIEW public.v3 RESET (security_invoker);\nALTER VIEW v2 RENAME TO v4;\nCREATE MATERIALIZED VIEW public.m AS SELECT * FROM contacts;\nALTER VIEW other.x SET SCHEMA public;' },
      { file: 'd', sql: 'CREATE VIEW public.gone AS SELECT 1;\nDROP VIEW IF EXISTS public.gone CASCADE;' },
    ])
    expect(Object.fromEntries([...views].map(([n, v]) => [n, v.invoker && !v.materialized]))).toEqual({ v1: false, v3: false, v4: true, m: false, x: false })
    expect(views.get('v4').reads).toEqual(['contacts', 'consent_log'])
  })

  it("viewReplay is not fooled by a '/*' in a string or a commented-out option", () => {
    const views = viewReplay([{ file: 'a', sql: "SELECT '/*';\nCREATE VIEW public.v AS SELECT * FROM public.contacts;\nSELECT '*/';\n-- ALTER VIEW public.v SET (security_invoker = on);" }])
    expect(views.get('v')).toMatchObject({ invoker: false })
  })

  it('functionReplay: definer or not, what the body writes, the latest CREATE wins, DROP removes', () => {
    const fns = functionReplay([
      { file: 'a', sql: 'CREATE FUNCTION public.f(a int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\' AS $fn$\nBEGIN UPDATE public.contacts SET x = 1; INSERT INTO consent_log VALUES (1); END $fn$;\nCREATE FUNCTION public.g() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.rosters $$;' },
      { file: 'b', sql: "CREATE OR REPLACE FUNCTION public.g() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$ SECURITY DEFINER;\nCREATE FUNCTION public.h() RETURNS trigger AS $$ BEGIN -- UPDATE public.contacts\nRETURN NEW; END $$ LANGUAGE plpgsql SECURITY DEFINER;\nDROP FUNCTION IF EXISTS public.gone(int);" },
    ])
    expect(fns.get('f')).toMatchObject({ definer: true, writes: ['contacts', 'consent_log'] })
    expect(fns.get('g')).toMatchObject({ definer: true, writes: [] })
    expect(fns.get('h')).toMatchObject({ definer: true, writes: [] })
  })

  it('clientExecuteGrants: EXECUTE or ALL on a public function to a client role', () => {
    expect(clientExecuteGrants('GRANT EXECUTE ON FUNCTION public.f(int) TO authenticated;\nGRANT ALL ON FUNCTION g() TO anon, service_role;\nGRANT EXECUTE ON FUNCTION public.h() TO service_role;\n-- GRANT EXECUTE ON FUNCTION public.k() TO authenticated;'))
      .toEqual(['f', 'g'])
  })

  it('roleLeaks: memberships both ways and ownership, Supabase authenticator excepted', () => {
    for (const sql of [
      'GRANT service_role TO authenticated;',
      'GRANT authenticated TO sneaky;',
      'CREATE ROLE sneaky LOGIN IN ROLE authenticated;',
      'CREATE ROLE wide ROLE anon, authenticated;',
      'ALTER GROUP service_role ADD USER authenticated;',
      'ALTER GROUP authenticated ADD USER sneaky;',
      'ALTER TABLE public.contacts OWNER TO authenticated;',
      'ALTER FUNCTION public.f() OWNER TO anon;',
      "SELECT '/*';\nGRANT service_role TO authenticated;\nSELECT '*/';",
    ]) expect(roleLeaks(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT anon TO authenticator;',
      'GRANT SELECT ON public.contacts TO authenticated;',
      'GRANT USAGE ON SCHEMA public TO anon;',
      'CREATE ROLE reporting NOLOGIN;',
      'ALTER TABLE public.contacts OWNER TO postgres;',
      '-- GRANT service_role TO authenticated;',
    ]) expect(roleLeaks(sql), sql).toEqual([])
  })

  it('movedInto: SET SCHEMA public, or a rename onto a closed name', () => {
    for (const sql of [
      'ALTER TABLE staging.contacts SET SCHEMA public;',
      'ALTER VIEW IF EXISTS other.v SET SCHEMA "public";',
      'ALTER TABLE public.contacts_new RENAME TO contacts;',
    ]) expect(movedInto(sql), sql).not.toEqual([])
    for (const sql of [
      'ALTER TABLE public.contacts RENAME TO contacts_old;',
      'ALTER TABLE public.notes SET SCHEMA archive;',
      'ALTER TABLE public.contacts RENAME COLUMN a TO b;',
    ]) expect(movedInto(sql), sql).toEqual([])
  })

  it('relationsRead / tablesWritten read only public targets', () => {
    expect(relationsRead('SELECT * FROM public.contacts c LEFT JOIN private.x ON true JOIN "consent_log" USING (id)')).toEqual(['contacts', 'consent_log'])
    expect(tablesWritten('UPDATE contacts SET a = 1; DELETE FROM public.rosters; INSERT INTO private.audit VALUES (1); TRUNCATE TABLE public.cars; MERGE INTO teams t USING x ON true')).toEqual(['contacts', 'rosters', 'cars', 'teams'])
  })
})
