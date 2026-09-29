// FNEXECSWEEP.1 guard (mig 664). Since 664 a function postgres creates in
// public is executable by postgres + service_role only: the default
// privileges no longer hand EXECUTE to PUBLIC, anon or authenticated. So the
// failure mode FLIPS: forgetting a REVOKE is now closed by default, while
// forgetting a GRANT breaks a live screen with 42501. Pinned here:
//
//  1. A migration from 664 on that CREATEs a non-trigger function in public
//     states its EXECUTE decision in the same file: GRANT EXECUTE … TO
//     authenticated (a signed-in client calls it), or REVOKE EXECUTE … FROM
//     PUBLIC, anon, authenticated (server-only; still correct on a database
//     whose defaults were reset). Trigger functions need neither: a trigger
//     fires without the firing role holding EXECUTE.
//  2. No migration from 664 on gives anon or PUBLIC EXECUTE on a public
//     function (ANON_EXECUTE_ALLOWED is empty), or blanket EXECUTE through
//     ALL FUNCTIONS/ROUTINES IN SCHEMA public to a client role.
//  3. No migration from 664 on re-opens the default: ALTER DEFAULT PRIVILEGES
//     … GRANT … ON FUNCTIONS/ROUTINES to a client role, with no IN SCHEMA or
//     IN SCHEMA public. (private and extensions keep PUBLIC on purpose.)
//  4. Every .rpc('<name>') in client-run code (shared/, mobile/, and src/
//     files that are 'use client', import createBrowserClient or call
//     createAuthClient()) is in CLIENT_RPCS, and the LATEST migration that
//     creates each CLIENT_RPCS function also grants it EXECUTE to
//     authenticated (DROP + CREATE resets the ACL to the closed default).
//
// champ-app (another repo) calls the same two RPCs from its browser
// (src/app/account/devices/ScanForStraps.jsx, account/integrations/page.jsx):
// a new champ-app client RPC needs its grant here too.
// Comments are blanked by a quote-aware SQL scan (sqlCode) and by the
// TypeScript parser's comment ranges (stripComments), never by a regex, so a
// '/*' or '--' inside a string cannot hide the code after it.
// A floor, not a proof: an .rpc name held in a variable, or SQL built at
// runtime, is invisible.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { stripComments as stripCommentsNoRegex } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const FN_EXECUTE_MIGRATION = 664
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

/** RPCs a signed-in client session may call. Add one only with its GRANT. */
export const CLIENT_RPCS = ['list_enabled_integrations', 'scan_straps_for_contact']
/** Public functions anon/PUBLIC may execute. Empty on purpose. */
export const ANON_EXECUTE_ALLOWED = []

const CLIENT_ROLES = ['anon', 'authenticated', 'public']
const ident = (s) => s.trim().replace(/"/g, '').toLowerCase()
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

/**
 * The SQL with its comments blanked (newlines kept), by a quote-aware scan:
 * '…' (with '' doubling, and backslash escapes in E'…'), "…" identifiers and
 * $tag$…$tag$ bodies are never read as comment markers, so a '/*' or '--'
 * inside one cannot hide code. Block comments nest, as in Postgres. A
 * dollar-quoted body is scanned the same way on its own (function and DO
 * bodies are SQL too, so a commented-out GRANT inside one is not a
 * decision); its end is found first, so nothing inside can run past it.
 * String contents are kept verbatim: a GRANT run from EXECUTE '…' counts.
 */
export function sqlCode(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const DOLLAR = /\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      out += blank(sql.slice(i, j))
      i = j
      continue
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      DOLLAR.lastIndex = i
      const m = DOLLAR.exec(sql)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) { out += sql.slice(i); break }
        out += tag + sqlCode(sql.slice(i + tag.length, end)) + tag
        i = end + tag.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
// One statement each: no part may cross a ';' (a GRANT with no ON, such as a
// role membership, must not swallow the statements after it), and the role
// list also ends at a quote or a dollar tag (a GRANT run from EXECUTE '…').
const GRANT_RE = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const REVOKE_RE = /\brevoke\s+([^;]+?)\s+on\s+([^;]+?)\s+from\s+([^;'$]+)/gi
const CREATE_FN_RE = /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+((?:"?[a-z_][\w]*"?\s*\.\s*)?"?[a-z_][\w]*"?)\s*\(/gi
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+grant\s+option|granted\s+by\b|cascade|restrict)[\s\S]*$/i, '')).map(ident)

function splitName(qualified) {
  const parts = qualified.split('.').map(ident)
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] }
}

/** Index just past the ')' that closes the '(' at openIdx. */
function afterArgs(code, openIdx) {
  let depth = 0
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') { depth--; if (depth === 0) return i + 1 }
  }
  return code.length
}

/** Every CREATE FUNCTION in the file: { schema, name, trigger }. Unqualified = public. */
export function createdFunctions(sql) {
  const code = sqlCode(sql)
  const out = []
  for (const m of code.matchAll(CREATE_FN_RE)) {
    const end = afterArgs(code, m.index + m[0].length - 1)
    out.push({ ...splitName(m[1]), trigger: /^\s*returns\s+(event_)?trigger\b/i.test(code.slice(end, end + 200)) })
  }
  return out
}

/** Function names in a GRANT/REVOKE target ("function a(uuid), public.b()"). */
function functionTargets(target) {
  const t = target.trim()
  if (!/^(function|procedure|routine)\s/i.test(t)) return []
  return splitTop(t.replace(/^(function|procedure|routine)\s+/i, '')).map((item) => splitName(item.replace(/\([\s\S]*$/, '')))
}

/** EXECUTE decisions in one migration (ALTER DEFAULT PRIVILEGES excluded). */
export function executeDecisions(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const granted = new Set()
  const revokedFrom = new Map()
  const clientGrants = []
  const blanket = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_RE)) {
    if (!/\b(execute|all)\b/i.test(privs)) continue
    const roles = rolesOf(to)
    const all = target.trim().match(/^all\s+(functions|routines|procedures)\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) {
      if (splitTop(all[2]).map(ident).includes('public') && roles.some((r) => CLIENT_ROLES.includes(r))) blanket.push(stmt.trim())
      continue
    }
    for (const fn of functionTargets(target)) {
      if (fn.schema !== 'public') continue
      if (roles.includes('authenticated')) granted.add(fn.name)
      if ((roles.includes('anon') || roles.includes('public')) && !ANON_EXECUTE_ALLOWED.includes(fn.name)) clientGrants.push(stmt.trim())
    }
  }
  for (const [, privs, target, from] of code.matchAll(REVOKE_RE)) {
    // REVOKE GRANT OPTION FOR … leaves the privilege itself in place.
    if (!/\b(execute|all)\b/i.test(privs) || /^\s*grant\s+option\s+for\b/i.test(privs)) continue
    for (const fn of functionTargets(target)) {
      if (fn.schema !== 'public') continue
      const set = revokedFrom.get(fn.name) ?? new Set()
      for (const r of rolesOf(from)) set.add(r)
      revokedFrom.set(fn.name, set)
    }
  }
  const revoked = new Set([...revokedFrom].filter(([, set]) => CLIENT_ROLES.every((r) => set.has(r))).map(([name]) => name))
  return { granted, revoked, clientGrants, blanket }
}

/** Non-trigger public functions created with no EXECUTE decision in the same file. */
export function missingDecisions(sql) {
  const { granted, revoked } = executeDecisions(sql)
  return [...new Set(createdFunctions(sql)
    .filter((f) => f.schema === 'public' && !f.trigger && !granted.has(f.name) && !revoked.has(f.name))
    .map((f) => f.name))]
}

/** ALTER DEFAULT PRIVILEGES that re-open functions in public (or globally) to a client role. */
export function defaultReopeners(sql) {
  const hits = []
  for (const [stmt] of sqlCode(sql).matchAll(ADP_RE)) {
    if (!/\bgrant\s+[\s\S]+?\s+on\s+(functions|routines)\b/i.test(stmt)) continue
    const to = stmt.match(/\bto\s+([\s\S]+?)\s*;?\s*$/i)
    if (!to || !rolesOf(to[1]).some((r) => CLIENT_ROLES.includes(r))) continue
    const schemas = stmt.match(/\bin\s+schema\s+([\s\S]+?)\s+grant\b/i)
    if (!schemas || splitTop(schemas[1]).map(ident).includes('public')) hits.push(stmt.trim())
  }
  return hits
}

// ── client code ──────────────────────────────────────────────────────────
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
/**
 * JS/TS with comments blanked, from the TypeScript parser's own comment
 * ranges, so a '/*' or '//' inside a string, template or regex literal is
 * never read as a comment. A file the parser rejects falls back to the
 * repo's quote-aware state machine (scripts/lib/strip-comments.mjs), never
 * to a regex.
 */
export function stripComments(text) {
  const sf = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  if (sf.parseDiagnostics?.length) {
    const js = ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
    if (js.parseDiagnostics?.length) return stripCommentsNoRegex(text)
    return blankComments(text, js)
  }
  return blankComments(text, sf)
}
function blankComments(text, sf) {
  const ranges = new Map()
  const visit = (node) => {
    for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.set(r.pos, r.end)
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, end] of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end)
  return out
}

function isClientFile(text) {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code)
}
const RPC = /\.rpc\(\s*['"`]([A-Za-z_][\w]*)['"`]/g
/** .rpc('<name>') calls in one file's code (comments excluded). */
export const rpcNames = (text) => (text.includes('.rpc(') ? [...stripComments(text).matchAll(RPC)].map((m) => m[1]) : [])
/** The RPC names a src/ file calls from a client session ([] for server-only files). */
export const clientRpcNames = (text) => (text.includes('.rpc(') && isClientFile(text) ? rpcNames(text) : [])
function clientRpcCalls() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
    .flatMap((f) => rpcNames(readFileSync(f, 'utf8')).map((name) => ({ file: rel(f), name })))
  const browser = walk(path.join(ROOT, 'src'))
    .flatMap((f) => clientRpcNames(readFileSync(f, 'utf8')).map((name) => ({ file: rel(f), name })))
  return [...phone, ...browser]
}

const migrationFiles = () => readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))
const readMig = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')

describe('later migrations keep public functions closed by default (mig 664)', () => {
  it('mig 664 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${FN_EXECUTE_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= FN_EXECUTE_MIGRATION)
  it.each(later)('%s: every new public function has an EXECUTE decision; nothing opens to anon/PUBLIC; the default stays closed', (file) => {
    const sql = readMig(file)
    const { clientGrants, blanket } = executeDecisions(sql)
    expect(missingDecisions(sql), `${file}: add GRANT EXECUTE … TO authenticated (a client calls it) or REVOKE EXECUTE … FROM PUBLIC, anon, authenticated (server-only)`).toEqual([])
    expect(clientGrants, `${file}: anon/PUBLIC may not execute a public function (mig 664)`).toEqual([])
    expect(blanket, `${file}: no blanket EXECUTE on ALL FUNCTIONS IN SCHEMA public to a client role (mig 664)`).toEqual([])
    expect(defaultReopeners(sql), `${file}: the public function default stays service_role-only (mig 664)`).toEqual([])
  })
})

describe('the detectors', () => {
  it('missingDecisions catches a forgotten decision and passes the safe forms', () => {
    for (const [sql, want] of [
      ['CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', ['f']],
      ['create or replace function g(p uuid) returns void language sql as $$ select $$;', ['g']],
      ["DROP FUNCTION IF EXISTS public.h(); CREATE FUNCTION public.h() RETURNS int LANGUAGE sql AS 'SELECT 1';", ['h']],
      ['CREATE FUNCTION public.k() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; REVOKE EXECUTE ON FUNCTION public.k() FROM PUBLIC;', ['k']],
    ]) expect(missingDecisions(sql), sql).toEqual(want)
    for (const sql of [
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; GRANT EXECUTE ON FUNCTION public.f() TO authenticated;',
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC, anon, authenticated;',
      `CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
       REVOKE ALL ON FUNCTION public.f() FROM PUBLIC;
       REVOKE EXECUTE ON FUNCTION public.f() FROM anon;
       GRANT EXECUTE ON FUNCTION public.f() TO authenticated;`,
      `CREATE FUNCTION public.a() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
       CREATE FUNCTION public.b(p uuid) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
       REVOKE EXECUTE ON FUNCTION public.a(), public.b(uuid) FROM PUBLIC, anon, authenticated;`,
      `CREATE FUNCTION public.m(p numeric(10,2) DEFAULT round(1.5)) RETURNS void LANGUAGE sql AS $$ SELECT $$;
       GRANT EXECUTE ON FUNCTION public.m(numeric) TO authenticated;`,
      'CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
      'CREATE FUNCTION private.p() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;',
      '-- CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      "EXECUTE format('CREATE FUNCTION %I._probe() RETURNS integer LANGUAGE sql AS %L', v_schema, 'SELECT 1');",
    ]) expect(missingDecisions(sql), sql).toEqual([])
  })

  it('clientGrants / blanket catch anon, PUBLIC and schema-wide grants', () => {
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION public.f() TO anon;',
      'GRANT ALL ON FUNCTION f() TO PUBLIC;',
      'GRANT EXECUTE ON FUNCTION public.a(), public.b(uuid) TO authenticated, anon;',
    ]) expect(executeDecisions(sql).clientGrants, sql).not.toEqual([])
    for (const sql of [
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;',
      'grant all on all routines in schema public to anon;',
    ]) expect(executeDecisions(sql).blanket, sql).not.toEqual([])
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION public.f() TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.f() TO service_role;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      '-- rollback: GRANT EXECUTE ON FUNCTION public.f() TO anon;',
    ]) {
      const d = executeDecisions(sql)
      expect([...d.clientGrants, ...d.blanket], sql).toEqual([])
    }
  })

  it('defaultReopeners catches a re-opened public/global default and passes private/extensions and revokes', () => {
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'alter default privileges for role postgres in schema public, private grant all on routines to authenticated;',
    ]) expect(defaultReopeners(sql), sql).not.toEqual([])
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;',
    ]) expect(defaultReopeners(sql), sql).toEqual([])
  })
})

describe('the scanners never let a comment marker inside a string hide code', () => {
  it('SQL: a /* inside a -- comment or a string does not hide what follows', () => {
    const fn = 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'
    expect(missingDecisions(`-- see a/* b\n${fn}\n-- */`)).toEqual(['f'])
    expect(missingDecisions(`SELECT '/*';\n${fn}\nSELECT '*/';`)).toEqual(['f'])
    expect(missingDecisions(`SELECT E'it\\'s /*';\n${fn}\nSELECT '*/';`)).toEqual(['f'])
    expect(missingDecisions(`COMMENT ON SCHEMA x IS $c$ it's -- /* $c$;\n${fn}\nSELECT '*/';`)).toEqual(['f'])
  })

  it("SQL: a -- inside a string does not hide the rest of its line", () => {
    const sql = "CREATE FUNCTION public.f() RETURNS text LANGUAGE sql AS $$ SELECT '--' $$; GRANT EXECUTE ON FUNCTION public.f() TO anon;"
    expect(executeDecisions(sql).clientGrants).not.toEqual([])
  })

  it('SQL: block comments nest, as they do in Postgres', () => {
    expect(missingDecisions('/* a /* b */ CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; */')).toEqual([])
  })

  it('SQL: a commented-out GRANT inside a function body is not a decision', () => {
    expect(missingDecisions(`CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        -- GRANT EXECUTE ON FUNCTION public.f() TO authenticated;
        /* REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC, anon, authenticated; */
        RETURN 1;
      END $$;`)).toEqual(['f'])
  })

  it('SQL: a GRANT without ON (role membership) does not swallow the next statements', () => {
    const sql = `GRANT sneaky TO authenticated;
      REVOKE ALL ON TABLE public.t FROM anon;
      GRANT EXECUTE ON FUNCTION public.f() TO anon;`
    expect(executeDecisions(sql).clientGrants).not.toEqual([])
  })

  it('SQL: REVOKE GRANT OPTION FOR keeps EXECUTE, so it is not a decision', () => {
    expect(missingDecisions(`CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.f() FROM PUBLIC, anon, authenticated;`)).toEqual(['f'])
  })

  it('SQL: a procedure needs a decision too (ON FUNCTIONS defaults cover procedures)', () => {
    expect(missingDecisions('CREATE OR REPLACE PROCEDURE public.p(a int) LANGUAGE sql AS $$ SELECT 1 $$;')).toEqual(['p'])
    expect(missingDecisions(`CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 1 $$;
      REVOKE EXECUTE ON PROCEDURE public.p() FROM PUBLIC, anon, authenticated;`)).toEqual([])
  })

  it('SQL: a GRANT run from a DO block string still counts', () => {
    expect(executeDecisions("DO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO anon'; END $$;").clientGrants).not.toEqual([])
  })

  it('JS: a /* inside a regex literal or a string does not hide a client .rpc()', () => {
    expect(clientRpcNames("'use client'\nconst re = /\\/*/\nsupabase.rpc('evil')\nconst s = '*/'\n")).toEqual(['evil'])
    expect(clientRpcNames("'use client'\nconst s = '/*'\nsupabase.rpc('evil')\nconst t = '*/'\n")).toEqual(['evil'])
  })

  it('JS: comments are not calls; server files are not client files', () => {
    expect(clientRpcNames("/* header */\n'use client'\n// supabase.rpc('old')\nsupabase.rpc('now')\n")).toEqual(['now'])
    expect(clientRpcNames("import { createAuthClient } from '@/lib/auth'\nconst db = await createAuthClient()\ndb.rpc('as_user')\n")).toEqual(['as_user'])
    expect(clientRpcNames("// 'use client'\nimport { createServerClient } from '@/lib/supabase'\ndb.rpc('server_only')\n")).toEqual([])
  })
})

describe('client-run code calls only RPCs a signed-in client may execute (mig 664)', () => {
  const calls = clientRpcCalls()

  it('the scan is not blind: it finds the member app\'s own calls', () => {
    expect(calls).toEqual(expect.arrayContaining([
      { file: 'mobile/app/(member)/account/devices.jsx', name: 'scan_straps_for_contact' },
      { file: 'mobile/app/(member)/account/integrations.jsx', name: 'list_enabled_integrations' },
    ]))
  })

  it('every client .rpc() is in CLIENT_RPCS', () => {
    expect(calls.filter((c) => !CLIENT_RPCS.includes(c.name)).map((c) => `${c.file}: rpc('${c.name}')`)).toEqual([])
  })

  it.each(CLIENT_RPCS)('%s: the latest migration that creates it also grants EXECUTE to authenticated', (name) => {
    const creators = migrationFiles().filter((f) => createdFunctions(readMig(f)).some((c) => c.schema === 'public' && c.name === name))
    expect(creators.length, `${name}: no migration creates it`).toBeGreaterThan(0)
    const last = creators.at(-1)
    expect(executeDecisions(readMig(last)).granted.has(name), `${last} creates ${name} without GRANT EXECUTE … TO authenticated`).toBe(true)
  })
})
