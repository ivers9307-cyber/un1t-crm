// CLOSEDFNREGRANT.1 (C147) guard: a function a migration closed to client
// roles stays closed in every later migration.
//
// Prod's pg_default_acl gives authenticated EXECUTE on every function postgres
// creates in schema private (mig 678's deliberate default, so policy helpers
// work). A later migration that DROPs and re-CREATEs a closed function (or
// creates it with plain CREATE FUNCTION, or renames another function onto its
// name) makes a new function object with that default ACL, and silently
// reopens it. The GRANT-only guard this replaces, in mig 700's test, could
// not see that.
//
// Pinned here, for each function in tests/helpers/closed-functions.js (the
// one registry):
//  1. Its closing migration leaves it closed to authenticated, anon, PUBLIC.
//  2. Every later migration leaves it closed: a (re)CREATE that makes a new
//     function object must be followed, in the same file, by a REVOKE of
//     EXECUTE (or ALL) from authenticated, anon and PUBLIC; and no GRANT of
//     EXECUTE (or ALL) gives a client role it back. CREATE OR REPLACE of a
//     function that still exists keeps its ACL, so it is fine on its own. A
//     DROP in one file and a CREATE in a later one counts as a re-CREATE.
//  3. Every function a migration from 677 on REVOKEs from authenticated by
//     name is in the registry (so a new closer has to register).
//
// A floor, not a proof: SQL built at runtime is invisible, ALTER FUNCTION …
// SET SCHEMA is not followed, and overloads are not told apart.
// Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { CLOSED_FUNCTIONS, CLIENT_ROLES, walkFunction, closedToAuthenticated, fnName } from './helpers/closed-functions.js'

const MIGRATIONS = path.resolve(import.meta.dirname, '../supabase/migrations')
const FIRST_CLOSER_SCAN = 677
const num = (f) => Number.parseInt(f, 10)
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort((a, b) => (num(a) - num(b)) || a.localeCompare(b))
const mig = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')
const OPEN_ALL = { present: true, open: CLIENT_ROLES }
const CLOSED = { present: true, open: [] }

/** The migration with that number that closes `fn` (prefixes repeat on purpose). */
const closerOf = ({ fn, closedBy }) =>
  files.find((f) => num(f) === closedBy && walkFunction(mig(f), fn, OPEN_ALL).open.length === 0)

describe('the closed-function registry', () => {
  it('names each function once, schema-qualified', () => {
    const fns = CLOSED_FUNCTIONS.map((c) => c.fn)
    expect(new Set(fns).size).toBe(fns.length)
    for (const fn of fns) expect(fn).toMatch(/^(private|public)\.[a-z_][a-z0-9_]*$/)
  })

  it.each(CLOSED_FUNCTIONS)('$fn: migration $closedBy closes it to authenticated, anon and PUBLIC', (c) => {
    expect(closerOf(c), `${c.fn}: no migration numbered ${c.closedBy} leaves it closed to ${CLIENT_ROLES.join(', ')}`).toBeTruthy()
  })

  const scanned = files.filter((f) => num(f) >= FIRST_CLOSER_SCAN)
  it.each(scanned)('%s: every function it closes to authenticated is registered', (file) => {
    const missing = closedToAuthenticated(mig(file))
      .filter((fn) => !CLOSED_FUNCTIONS.some((c) => c.fn === fn && c.closedBy <= num(file)))
    expect(missing, `${file} closes these to authenticated: add them to CLOSED_FUNCTIONS in tests/helpers/closed-functions.js`).toEqual([])
  })
})

describe('later migrations keep each closed function closed', () => {
  it.each(CLOSED_FUNCTIONS)('$fn (closed by $closedBy) stays closed', (c) => {
    const closer = closerOf(c)
    expect(closer).toBeTruthy()
    const offenders = []
    let state = CLOSED
    for (const f of files.slice(files.indexOf(closer) + 1)) {
      state = walkFunction(mig(f), c.fn, state)
      if (state.open.length) {
        offenders.push(`${f}: ${c.fn}${c.args} is executable by ${state.open.join(', ')}`)
        state = { ...state, open: [] }
      }
    }
    expect(offenders, `${c.fn} was closed by ${c.closedBy} (${c.why}). A DROP + CREATE takes the default ACL: `
      + `follow the CREATE with REVOKE EXECUTE ON FUNCTION ${c.fn}${c.args} FROM PUBLIC, anon, authenticated; in the same file`).toEqual([])
  })
})

describe('the detector', () => {
  const FN = 'private.get_user_role'
  const DROP = 'DROP FUNCTION IF EXISTS private.get_user_role(uuid);'
  const CREATE = 'CREATE FUNCTION private.get_user_role(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT \'x\' $$;'
  const REPLACE = 'CREATE OR REPLACE FUNCTION private.get_user_role(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT \'x\' $$;'
  const REVOKE = 'REVOKE EXECUTE ON FUNCTION private.get_user_role(uuid) FROM PUBLIC, anon, authenticated;'
  const openAfter = (sql, state = CLOSED) => walkFunction(sql, FN, state).open

  it('flags a DROP + CREATE with no REVOKE after it', () => {
    expect(openAfter([DROP, CREATE].join('\n'))).toEqual(CLIENT_ROLES)
    expect(openAfter([DROP, REPLACE].join('\n'))).toEqual(CLIENT_ROLES)
    expect(openAfter([DROP, REVOKE, CREATE].join('\n')), 'a REVOKE before the CREATE closes nothing').toEqual(CLIENT_ROLES)
    expect(openAfter('drop function "private"."get_user_role"(uuid) cascade;\ncreate or replace function "private"."get_user_role"(p uuid) returns text language sql as $f$ select 1::text $f$;'))
      .toEqual(CLIENT_ROLES)
  })

  it('passes a DROP + CREATE followed by the REVOKE, and a plain CREATE OR REPLACE', () => {
    expect(openAfter([DROP, CREATE, REVOKE, 'GRANT EXECUTE ON FUNCTION private.get_user_role(uuid) TO service_role;'].join('\n'))).toEqual([])
    expect(openAfter([DROP, REPLACE, 'REVOKE ALL ON FUNCTION private.get_user_role(uuid), private.x() FROM PUBLIC, anon, authenticated;'].join('\n'))).toEqual([])
    expect(openAfter([DROP, CREATE, 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;'].join('\n'))).toEqual([])
    expect(openAfter(REPLACE)).toEqual([])
  })

  it('wants all three client roles revoked', () => {
    expect(openAfter([DROP, CREATE, 'REVOKE EXECUTE ON FUNCTION private.get_user_role(uuid) FROM authenticated;'].join('\n'))).toEqual(['anon', 'public'])
    expect(openAfter([DROP, CREATE, 'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION private.get_user_role(uuid) FROM PUBLIC, anon, authenticated;'].join('\n')))
      .toEqual(CLIENT_ROLES)
  })

  it('a plain CREATE FUNCTION, a RENAME onto the name, and a DROP carried from an earlier file are new objects', () => {
    expect(openAfter(CREATE)).toEqual(CLIENT_ROLES)
    expect(openAfter('ALTER FUNCTION private.get_user_role_v2(uuid) RENAME TO get_user_role;')).toEqual(CLIENT_ROLES)
    const afterDrop = walkFunction(DROP, FN, CLOSED)
    expect(afterDrop).toEqual({ present: false, open: [] })
    expect(openAfter(REPLACE, afterDrop)).toEqual(CLIENT_ROLES)
    expect(openAfter([REPLACE, REVOKE].join('\n'), afterDrop)).toEqual([])
  })

  it('a statement run from a DO block counts; a commented-out one does not', () => {
    expect(openAfter(`DO $$ BEGIN EXECUTE 'DROP FUNCTION private.get_user_role(uuid)'; END $$;\n${CREATE}`)).toEqual(CLIENT_ROLES)
    expect(openAfter([DROP, CREATE, `-- ${REVOKE}`].join('\n'))).toEqual(CLIENT_ROLES)
    expect(openAfter([DROP, CREATE, `/* ${REVOKE} */`].join('\n'))).toEqual(CLIENT_ROLES)
    expect(openAfter(`-- ${DROP}\n${REPLACE}`)).toEqual([])
  })

  it('flags a GRANT back to a client role (the shapes mig 700\'s guard pinned)', () => {
    expect(openAfter('GRANT EXECUTE ON FUNCTION private.get_user_role(uuid) TO authenticated;')).toEqual(['authenticated'])
    expect(openAfter('grant all on function private.get_user_role(uuid), private.x() to service_role, public;')).toEqual(['public'])
    expect(openAfter('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;')).toEqual(['authenticated'])
    expect(walkFunction('GRANT EXECUTE ON FUNCTION private.mobile_can_for(uuid, uuid, text) TO anon;', 'private.mobile_can_for').open).toEqual(['anon'])
    expect(openAfter('GRANT EXECUTE ON FUNCTION private.get_user_role(uuid) TO service_role;')).toEqual([])
    expect(openAfter('GRANT EXECUTE ON FUNCTION private.auth_is_manager_at(uuid) TO authenticated;')).toEqual([])
    expect(openAfter('-- GRANT EXECUTE ON FUNCTION private.get_user_role(uuid) TO authenticated;')).toEqual([])
    expect(openAfter('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated;')).toEqual([])
  })

  it('leaves other functions alone', () => {
    expect(openAfter('DROP FUNCTION private.get_user_role_at(uuid, uuid);\nCREATE FUNCTION private.get_user_role_at(a uuid, b uuid) RETURNS text LANGUAGE sql AS $$ SELECT 1::text $$;'))
      .toEqual([])
    expect(openAfter('DROP FUNCTION public.get_user_role(uuid);\nCREATE FUNCTION get_user_role(a uuid) RETURNS text LANGUAGE sql AS $$ SELECT 1::text $$;')).toEqual([])
  })

  it('closedToAuthenticated reads the functions a REVOKE names', () => {
    expect(closedToAuthenticated('REVOKE EXECUTE ON FUNCTION private.a(uuid), public.b() FROM PUBLIC, anon, authenticated;')).toEqual(['private.a', 'public.b'])
    expect(closedToAuthenticated('REVOKE ALL ON FUNCTION private.a() FROM PUBLIC, anon;')).toEqual([])
    expect(closedToAuthenticated('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM authenticated;')).toEqual([])
    expect(closedToAuthenticated('REVOKE SELECT ON public.t FROM authenticated;')).toEqual([])
    expect(fnName('"Private"."Get_User_Role"(uuid)')).toBe('private.get_user_role')
    expect(fnName('get_user_role(uuid)')).toBe('public.get_user_role')
  })
})
