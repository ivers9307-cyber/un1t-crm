// ANYMEMBERWRITE.1 guard (mig 672). authenticated holds SELECT only on
// public.challenges and public.contact_segments (each keeps its one SELECT
// policy: challenges_read feeds the member Compete and Wrapped screens and
// champ-app's member loaders) and NOTHING on public.car_notes (RLS on, no
// policy); anon holds nothing on the three. Pinned here:
//
//  1. Browser and phone code never WRITES the three tables, and never touches
//     car_notes at all (no .from('car_notes') read, no embed of car_notes in
//     another table's select string, no realtime subscription). Client-bound
//     code = shared/, mobile/, and every src/ file that is 'use client' (after
//     any header comment), names createBrowserClient, calls createAuthClient()
//     or holds the anon key. A client write (or a car_notes read) is a 42501
//     after 672. Act through /api/challenges*, /api/contacts/segments* and
//     /api/cars/[id]/notes*, which check the caller's role or permission.
//  2. A later migration may not give authenticated any write privilege
//     (MAINTAIN included) on the three or any privilege at all on car_notes,
//     give anon or PUBLIC anything, do either through ALL TABLES IN SCHEMA
//     public, hand a client role another role, add a permissive
//     INSERT/UPDATE/DELETE/ALL policy (no FOR = ALL) or any permissive policy
//     on car_notes, disable RLS on one of them, or CREATE/RENAME a table to one
//     of the three names (the default ACL re-grants ALL to anon and
//     authenticated). A GRANT run from EXECUTE '…' counts. The one exemption
//     is a rollback migration named `<NNN>_anymemberwrite1_rollback.sql`.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; JSX text is never read as a comment), SQL comments by one quote-
// and dollar-aware pass that pairs each $tag$ body with its own closing tag
// (sqlCode, tests/function-execute-guard.test.js). A floor, not a proof: a
// builder held in a variable, a `.from(<variable>)` or SQL built at runtime
// is invisible. Server code is not checked: service_role bypasses grants.
// champ-app is another repo; it only READS challenges with a member session
// (src/lib/load-challenges.js, load-social.js, load-cohort-board.js), which
// 672 keeps (C83 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const ANY_MEMBER_WRITES_OFF_MIGRATION = 672
// Scanned from 631, not 672: migration numbers are reserved ahead of time and
// a lower number can merge later (663 is PR #1849, 631 the HELD #1774 when
// 672 was written). 631-671 hold nothing the detector flags (checked).
const SCAN_FROM = 631
const TABLES = ['challenges', 'contact_segments', 'car_notes']
const CLOSED = 'car_notes' // no client privilege at all, reads included
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_anymemberwrite1_rollback\.sql$/
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

/**
 * JS/TS with comments blanked (newlines and offsets kept), from the
 * TypeScript parser's own comment ranges, so a '/*' or '//' inside a string,
 * template or regex literal is never read as a comment. JSX text is not
 * trivia, but asked for comments at its start the scanner reads
 * `<p>/* note</p>` as one, so no range is taken at a position where JSX text
 * begins (tests/staff-profile-to-client.test.js). A file the parser cannot
 * read is returned raw: a false positive beats a blind spot.
 */
export function stripComments(text, file = 'scan.jsx') {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  if (sf.parseDiagnostics?.length) return text
  const jsxTextAt = new Set()
  const findJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxTextAt.add(node.pos)
    for (const child of node.getChildren(sf)) findJsxText(child)
  }
  findJsxText(sf)
  const ranges = new Map()
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.set(r.pos, r.end)
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, end] of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end)
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code.trimStart()) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
export const isClientFile = (text, file) => isClientCode(stripComments(text, file))

// Every file is parsed once per run (the TypeScript parse is the slow part).
const CODE = new Map()
const codeOfFile = (f) => {
  if (!CODE.has(f)) CODE.set(f, stripComments(readFileSync(f, 'utf8'), f))
  return CODE.get(f)
}
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

const WRITE = /\.from\(\s*['"`](challenges|contact_segments|car_notes)['"`]\s*\)\s*\??\.\s*(insert|update|upsert|delete)\s*\(/g
const CLOSED_READ = /\.from\(\s*['"`](car_notes)['"`]\s*\)\s*\??\.\s*select\s*\(/g
// A PostgREST embed inside another table's select string: 'id, car_notes(content)' or 'car_notes!fk(*)'.
// A '…' or "…" string ends at its line; a backtick template may span lines, and
// the house style is a multi-line template select with the embed on a later
// line (tests/consent-tables-client-closed-guard.test.js does the same).
const CLOSED_EMBED = /(?:['"][^'"\n]*?|`[^`]*?)\b(car_notes)\s*(?:!\s*\w+\s*)?\(/g
const CLOSED_REALTIME = /\btable\s*:\s*['"`](car_notes)['"`]/g
const READ = /\.from\(\s*['"`](challenges|contact_segments|car_notes)['"`]\s*\)\s*\??\.\s*select\s*\(/g

/** Every forbidden client use in already-stripped code, as "<table>.<op>". */
function usesIn(code) {
  return [
    ...[...code.matchAll(WRITE)].map((m) => `${m[1]}.${m[2]}`),
    ...[...code.matchAll(CLOSED_READ)].map((m) => `${m[1]}.select`),
    ...[...code.matchAll(CLOSED_EMBED)].map((m) => `${m[1]}.embed`),
    ...[...code.matchAll(CLOSED_REALTIME)].map((m) => `${m[1]}.realtime`),
  ]
}
/** Every forbidden client use in `text` (comments excluded). */
export const anyMemberTableUses = (text, file) => usesIn(stripComments(text, file))

// ── migrations ───────────────────────────────────────────────────────────
/**
 * The SQL with its comments blanked (newlines kept), by a quote-aware scan:
 * '…' (with '' doubling, and backslash escapes in E'…'), "…" identifiers and
 * $tag$…$tag$ bodies are never read as comment markers, so a '/*' or '--'
 * inside one cannot hide code. Block comments nest, as in Postgres. A
 * dollar-quoted body is matched to its own closing tag first and scanned the
 * same way on its own, so nothing inside can run past it. String contents
 * are kept verbatim: a GRANT run from EXECUTE '…' counts.
 * (tests/function-execute-guard.test.js sqlCode, copied verbatim rather than
 * imported: importing a test file would re-register its tests here.)
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
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
const tableName = (s) => ident(s).replace(/^public\s*\.\s*/, '')
const NAMES = '(?:"?public"?\\s*\\.\\s*)?"?(challenges|contact_segments|car_notes)"?'

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const GRANT_ROLE = /\bgrant\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const WRITE_PRIV = /\b(all|insert|update|delete|truncate|references|trigger|maintain)\b/i
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

/** Every statement in `sql` that would re-open one of the three tables to a client role. */
export function anyMemberReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_ON)) {
    const roles = rolesOf(to)
    const toAnon = roles.some((r) => r === 'anon' || r === 'public')
    const toAuth = roles.includes('authenticated')
    const toAuthWrite = toAuth && WRITE_PRIV.test(privs.replace(/\([^)]*\)/g, ' '))
    if (!toAnon && !toAuth) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    // Any client privilege through ALL TABLES reaches car_notes (closed to reads too).
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(t)) continue
    const named = splitTop(t.replace(/^table\s+/i, '')).map(tableName).filter((x) => TABLES.includes(x))
    if (named.length === 0) continue
    if (toAnon || toAuthWrite || named.includes(CLOSED)) hits.push(stmt.trim())
  }
  for (const [stmt, granted, to] of code.matchAll(GRANT_ROLE)) {
    if (/\s+on\s+/i.test(stmt)) continue
    if (splitTop(granted).map(ident).some((r) => PRIV_WORDS.includes(r))) continue
    if (rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAMES}(?=[\\s;])([^;]*)`, 'gi'))) {
    const body = m[2]
    if (/\bas\s+restrictive\b/i.test(body)) continue
    if (m[1].toLowerCase() === CLOSED) { hits.push(m[0].trim()); continue }
    const f = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)
    if (!f || f[1].toLowerCase() !== 'select') hits.push(m[0].trim())
  }
  // ALTER TABLE [IF EXISTS] [ONLY] <name> …: DISABLE RLS anywhere in a multi-action
  // statement, or the table handed to a client role (an owner bypasses its grants and RLS).
  const ALTER_ONE = `\\balter\\s+table\\s+(?:(?:only|if\\s+exists)\\s+)*${NAMES}(?=[\\s;])[^;]*?`
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bdisable\\s+row\\s+level\\s+security\\b`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bowner\\s+to\\s+"?(anon|authenticated|public)"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAMES}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(/\balter\s+table\s+[^;]*?\brename\s+to\s+"?(challenges|contact_segments|car_notes)"?(?=[\s;]|$)/gi)) hits.push(m[0].trim())
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code never writes challenges, segments or car notes, and never touches car notes (ANYMEMBERWRITE.1, mig 672)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police, and sees their reads (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/app/(member)/challenges.jsx', 'mobile/app/(member)/wrapped/challenge/[id].jsx',
      'src/components/ChallengeForm.jsx', 'src/app/(members)/challenges/page.js',
      'src/components/ContactsView.jsx', 'src/components/SavedSegmentsList.jsx', 'src/components/cars/NotesCard.jsx',
    ]))
    for (const server of ['src/app/api/challenges/route.js', 'src/app/api/cron/run-challenge-events/route.js',
      'src/app/api/contacts/segments/route.js', 'src/lib/sequences/segment-sync.js',
      'src/app/api/cars/[id]/notes/route.js', 'src/app/api/cars/[id]/issue-deposit-link/route.js']) {
      expect(names).not.toContain(server)
    }
    // the member Compete screen's and Challenge Wrapped's direct reads are seen
    for (const f of ['mobile/app/(member)/challenges.jsx', 'mobile/app/(member)/wrapped/challenge/[id].jsx']) {
      expect([...codeOfFile(path.join(ROOT, f)).matchAll(READ)].map((m) => m[1]), f).toEqual(['challenges'])
    }
  })

  it('no browser or phone file writes the three tables or touches car_notes', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of usesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'act through /api/challenges*, /api/contacts/segments*, /api/cars/[id]/notes* (mig 672 refuses client writes and car_notes reads)').toEqual([])
  })

  it('the detector catches every write shape and every car_notes use, and ignores reads it keeps, comments and look-alikes', () => {
    const bad = `
      await supabase.from('challenges').insert({ location_id, name, starts_on: today })
      await supabase.from("challenges")
        .update({ announced_start_at: null }).eq('id', id)
      await db.from(\`contact_segments\`).upsert(row)
      await supabase.from('contact_segments') . delete().eq('id', id)
      await supabase?.from('car_notes')?.insert({ kind: 'system' })
      await supabase.from('car_notes').select('content')
      await supabase.from('cars').select('id, car_notes(content, kind)')
      await supabase.from('cars').select(\`id, car_notes!car_notes_car_id_fkey(*)\`)
      await supabase
        .from('cars')
        .select(\`
          id, make,
          notes:car_notes!inner(content, kind)
        \`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'car_notes' }, cb)`
    expect(anyMemberTableUses(bad)).toEqual([
      'challenges.insert', 'challenges.update', 'contact_segments.upsert', 'contact_segments.delete', 'car_notes.insert',
      'car_notes.select', 'car_notes.embed', 'car_notes.embed', 'car_notes.embed', 'car_notes.realtime',
    ])
    const ok = `
      const { data } = await supabase.from('challenges').select('id, name, mode, metric, starts_on, ends_on, is_flagship')
      await supabase.from('contact_segments').select('id, name')
      // await supabase.from('challenges').delete().eq('id', id)
      /* await supabase.from('car_notes').select('*') */
      await fetch(\`/api/cars/\${carId}/notes\`, { method: 'POST' })
      await fetch('/api/contacts/segments', { method: 'POST' })
      await supabase.from('challenge_participants').insert(row)
      await supabase.from('car_notes_archive').delete()
      const label = 'car notes (manual)'`
    expect(anyMemberTableUses(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(anyMemberTableUses("const a = 'image/*'\nsupabase.from('challenges').update(p)\nconst b = '*/'\n"))
      .toEqual(['challenges.update'])
    expect(anyMemberTableUses("const r = /\\/*/\nsupabase.from('contact_segments').delete()\nconst s = '*/'\n"))
      .toEqual(['contact_segments.delete'])
    expect(anyMemberTableUses("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('challenges').insert(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['challenges.insert'])
    expect(anyMemberTableUses("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('car_notes').select('*') */}\n  </div>\n}\n"))
      .toEqual([])
  })

  it('finds every client-bound file: a comment header, createAuthClient, the anon key; not a comment', () => {
    expect(isClientFile("/* header */\n'use client'\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("// line one\n//\n\"use client\"\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("import { createAuthClient } from '@/lib/auth'\nconst db = await createAuthClient()\n")).toBe(true)
    expect(isClientFile("const c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)\n")).toBe(true)
    expect(isClientFile("// 'use client'\nimport { createServerClient } from '@/lib/supabase'\n")).toBe(false)
    expect(isClientFile("/* was createBrowserClient() before */\nexport const y = 1\n")).toBe(false)
  })
})

describe('later migrations keep the three tables closed to clients (mig 672)', () => {
  it('mig 672 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${ANY_MEMBER_WRITES_OFF_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it.each(later)('%s: no client write, no car_notes privilege, no anon grant, no permissive write policy, RLS kept', (file) => {
    expect(anyMemberReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens challenges/contact_segments/car_notes to a client role (mig 672). Write through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT INSERT ON public.challenges TO authenticated;',
      'grant update on table contact_segments to anon, authenticated;',
      'GRANT ALL ON "public"."challenges" TO PUBLIC;',
      'GRANT UPDATE (announced_start_at) ON public.challenges TO authenticated;',
      'GRANT MAINTAIN ON public.contact_segments TO authenticated;',
      'GRANT SELECT ON public.challenges TO anon;',
      'GRANT SELECT ON public.car_notes TO authenticated;',
      'GRANT SELECT (id, kind) ON public.car_notes TO authenticated;',
      'GRANT SELECT (id, name) ON public.contact_segments TO PUBLIC;',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT DELETE ON public.cars, public.car_notes TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.challenges TO authenticated'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT SELECT ON public.car_notes TO authenticated'; END $x$;`,
      'CREATE POLICY challenges_ins ON public.challenges FOR INSERT TO public WITH CHECK (true);',
      'create policy "x" on contact_segments to authenticated using (true);',
      'CREATE POLICY s ON public.contact_segments FOR ALL TO authenticated USING (true);',
      'CREATE POLICY car_notes_select ON public.car_notes FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY challenges_upd ON public.challenges FOR UPDATE USING (true);',
      'ALTER TABLE public.challenges DISABLE ROW LEVEL SECURITY;',
      'alter table only car_notes disable row level security;',
      'ALTER TABLE IF EXISTS ONLY public.challenges DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE ONLY public.contact_segments DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.car_notes ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
      'alter table "public"."challenges"\n  alter column name set not null,\n  disable row level security;',
      'ALTER TABLE public.car_notes OWNER TO authenticated;',
      'alter table if exists only challenges owner to anon;',
      'ALTER TABLE public.contact_segments OWNER TO "authenticated";',
      'GRANT challenge_writer TO authenticated;',
      'grant "some_role" to anon, authenticated;',
      'CREATE TABLE IF NOT EXISTS public.car_notes (id uuid);',
      'ALTER TABLE public.challenges_v2 RENAME TO challenges;',
      "SELECT '/*';\nGRANT UPDATE ON public.challenges TO authenticated;\nSELECT '*/';",
      "-- a note with /* in it\nGRANT UPDATE ON public.contact_segments TO authenticated;\n-- */",
      "COMMENT ON TABLE x IS $c$ it's -- /* $c$;\nGRANT UPDATE ON public.challenges TO authenticated;\nSELECT '*/';",
      // a '/*' inside a dollar body ends with that body: only $tag$ pairing sees the GRANT
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT SELECT ON public.car_notes TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(anyMemberReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT SELECT ON public.challenges TO authenticated;',
      'GRANT SELECT (id, name, starts_on, ends_on) ON public.challenges TO authenticated;',
      'GRANT SELECT ON public.contact_segments TO authenticated;',
      'GRANT ALL ON public.car_notes TO service_role;',
      'GRANT UPDATE ON public.cars TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.challenge_standings(uuid, text, timestamptz, timestamptz) TO authenticated;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.challenges, public.contact_segments, public.car_notes FROM anon, PUBLIC;',
      'CREATE POLICY challenges_read ON public.challenges FOR SELECT TO public USING (true);',
      'CREATE POLICY contact_segments_select ON public.contact_segments FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY d ON public.car_notes AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY p ON public.challenge_participants FOR ALL TO authenticated USING (true);',
      'CREATE POLICY p ON public.car_notes_archive FOR ALL TO authenticated USING (true);',
      'ALTER TABLE public.car_notes ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.cars DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.challenges_v2 DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.challenges ADD COLUMN x int; ALTER TABLE public.cars DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.challenges OWNER TO postgres;',
      'ALTER TABLE public.cars OWNER TO authenticated;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.challenge_participants (id uuid);',
      'ALTER TABLE public.challenges RENAME COLUMN name TO title;',
      '-- rollback: GRANT INSERT ON public.challenges TO authenticated;',
      '/* GRANT ALL ON public.car_notes TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT UPDATE ON public.contact_segments TO authenticated;
       END $$;`,
      'ALTER TABLE public.email_sequences ADD COLUMN segment_id uuid REFERENCES public.contact_segments(id);',
    ]
    for (const sql of ok) expect(anyMemberReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('673_anymemberwrite1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('673_challenges_regrant.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('673_watplclientwrite1_rollback.sql')).toBe(false)
  })
})
