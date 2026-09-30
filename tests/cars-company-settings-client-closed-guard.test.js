// CARSCLIENTWRITE.1 guard (mig 674). No client role (anon, authenticated,
// PUBLIC) holds any privilege on public.cars, public.car_documents,
// public.car_bca_submissions, public.car_bca_submission_events or
// public.company_settings, and none of them has a policy (RLS on). Pinned here:
//
//  1. Browser and phone code never touches the five tables: no .from('<t>')
//     (read or write), no embed of one in another table's select string, no
//     realtime subscription, no raw /rest/v1/<t> URL. Client-bound code =
//     shared/, mobile/, desktop/, and every src/ file that is 'use client'
//     (after any header comment), names createBrowserClient, calls
//     createAuthClient() or holds the anon key. Any of these is a 42501 after
//     674. Act through /api/cars*, /api/settings/branding and
//     /api/locations/[id]/{email-copy,email-spam-filter,send-quiet-hours},
//     which check car_processing, or owner/master AT the studio.
//  2. A later migration may not give anon, authenticated or PUBLIC any
//     privilege on the five (reads included), do it through ALL TABLES IN
//     SCHEMA public, hand a client role another role, add a permissive
//     policy of any command to one of them, disable RLS on one of them (any
//     ALTER TABLE form), make a client role its OWNER, or CREATE/RENAME a
//     table to one of the five names (the default ACL re-grants ALL to anon
//     and authenticated). A GRANT run from EXECUTE '…' counts. The one
//     exemption is a rollback migration named `<NNN>_carsclientwrite1_rollback.sql`.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; JSX text is never read as a comment), SQL comments by one quote-
// and dollar-aware pass that pairs each $tag$ body with its own closing tag
// (sqlCode, tests/function-execute-guard.test.js). Both helpers are copied
// verbatim from tests/any-member-write-tables-guard.test.js. A floor, not a
// proof: a table name held in a variable, a `.from(<variable>)` or SQL built
// at runtime is invisible. Server code is not checked: service_role bypasses
// grants. No other repo on this project touches the five with a client
// session (C94 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLOSED_MIGRATION = 674
// Scanned from 631, not 674: migration numbers are reserved ahead of time and
// a lower number can merge later (631 is the HELD #1774, 663 is #1849 when
// 674 was written). 631-673 hold nothing the detector flags (checked).
const SCAN_FROM = 631
const TABLES = ['cars', 'car_documents', 'car_bca_submissions', 'car_bca_submission_events', 'company_settings']
const T = TABLES.join('|')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_carsclientwrite1_rollback\.sql$/
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
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...walk(path.join(ROOT, 'desktop'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

// Any .from('<t>'), with the verb that follows it when there is one.
const FROM = new RegExp(`\\.from\\(\\s*['"\`](${T})['"\`]\\s*\\)(?:\\s*\\??\\.\\s*(\\w+)\\s*\\()?`, 'g')
// A PostgREST embed inside another table's select string: 'id, cars(make)' or
// 'car_documents!fk(*)'. A '…' or "…" string ends at its line; a backtick
// template may span lines (the house style is a multi-line template select).
const EMBED = new RegExp(`(?:['"][^'"\\n]*?|\`[^\`]*?)\\b(${T})\\s*(?:!\\s*\\w+\\s*)?\\(`, 'g')
const REALTIME = new RegExp(`\\btable\\s*:\\s*['"\`](${T})['"\`]`, 'g')
const REST = new RegExp(`/rest/v1/(${T})\\b`, 'g')

/** Every forbidden client use in already-stripped code, as "<table>.<op>". */
function usesIn(code) {
  return [
    ...[...code.matchAll(FROM)].map((m) => `${m[1]}.${m[2] || 'from'}`),
    ...[...code.matchAll(EMBED)].map((m) => `${m[1]}.embed`),
    ...[...code.matchAll(REALTIME)].map((m) => `${m[1]}.realtime`),
    ...[...code.matchAll(REST)].map((m) => `${m[1]}.rest`),
  ]
}
/** Every forbidden client use in `text` (comments excluded). */
export const carsClientUses = (text, file) => usesIn(stripComments(text, file))

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
const NAMES = `(?:"?public"?\\s*\\.\\s*)?"?(${T})"?`

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const GRANT_ROLE = /\bgrant\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

/** Every statement in `sql` that would re-open one of the five tables to a client role. */
export function carsReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, , target, to] of code.matchAll(GRANT_ON)) {
    if (!rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    // Any client privilege through ALL TABLES reaches the five (closed to reads too).
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(t)) continue
    if (splitTop(t.replace(/^table\s+/i, '')).map(tableName).some((x) => TABLES.includes(x))) hits.push(stmt.trim())
  }
  for (const [stmt, granted, to] of code.matchAll(GRANT_ROLE)) {
    if (/\s+on\s+/i.test(stmt)) continue
    if (splitTop(granted).map(ident).some((r) => PRIV_WORDS.includes(r))) continue
    if (rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAMES}(?=[\\s;])([^;]*)`, 'gi'))) {
    if (!/\bas\s+restrictive\b/i.test(m[2])) hits.push(m[0].trim())
  }
  // ALTER TABLE [IF EXISTS] [ONLY] <name> …: DISABLE RLS anywhere in a multi-action
  // statement, or the table handed to a client role (an owner bypasses its grants and RLS).
  const ALTER_ONE = `\\balter\\s+table\\s+(?:(?:only|if\\s+exists)\\s+)*${NAMES}(?=[\\s;])[^;]*?`
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bdisable\\s+row\\s+level\\s+security\\b`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bowner\\s+to\\s+"?(anon|authenticated|public)"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAMES}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\balter\\s+table\\s+[^;]*?\\brename\\s+to\\s+"?(${T})"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code never touches cars, car documents, BCA submissions or company settings (CARSCLIENTWRITE.1, mig 674)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/cars-api.js', 'mobile/app/(staff)/cars/index.jsx', 'mobile/app/(staff)/cars/[id].jsx',
      'src/components/cars/CarDetail.jsx', 'src/components/cars/DocumentsCard.jsx', 'src/components/cars/DepositCard.jsx',
      'src/components/CarDepositPage.jsx', 'src/components/settings/EmailSpamFilterCard.jsx', 'src/components/settings/EmailCopyCard.jsx',
    ]))
    for (const server of ['src/app/api/cars/route.js', 'src/app/api/cars/[id]/route.js', 'src/app/cars/[id]/page.js',
      'src/app/api/settings/branding/route.js', 'src/app/api/public/branding/route.js', 'src/lib/location-branding.js',
      'src/app/api/public/deposit/[token]/accept-and-pay/route.js', 'src/lib/bca-events.js']) {
      expect(names).not.toContain(server)
    }
  })

  it('no browser, phone or desktop file touches the five tables', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of usesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'act through /api/cars*, /api/settings/branding, /api/locations/[id]/* (mig 674 refuses every client read and write)').toEqual([])
  })

  it('the detector catches every use and ignores routes, storage buckets, comments and look-alikes', () => {
    const bad = `
      await supabase.from('cars').select('buyer_email')
      await supabase.from("cars")
        .update({ deposit_status: 'paid' }).eq('id', id)
      await db.from(\`car_documents\`).upsert(row)
      await supabase?.from('car_bca_submissions')?.select('download_token')
      await supabase.from('car_bca_submission_events').insert(ev)
      await supabase.from('company_settings') . delete().eq('id', id)
      const q = supabase.from('company_settings')
      await supabase.from('orders').select('id, cars(make, buyer_email)')
      await supabase.from('invoices_queue').select(\`id, car_documents!invoices_queue_source_car_document_id_fkey(*)\`)
      await supabase
        .from('locations')
        .select(\`
          id, name,
          settings:company_settings(logo_url)
        \`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'cars' }, cb)
      await fetch(\`\${SUPABASE_URL}/rest/v1/company_settings?select=*\`)`
    expect(carsClientUses(bad)).toEqual([
      'cars.select', 'cars.update', 'car_documents.upsert', 'car_bca_submissions.select', 'car_bca_submission_events.insert',
      'company_settings.delete', 'company_settings.from',
      'cars.embed', 'car_documents.embed', 'company_settings.embed', 'cars.realtime', 'company_settings.rest',
    ])
    const ok = `
      const { data } = await api('/api/cars?status=new')
      await fetch(\`/api/cars/\${carId}/documents\`, { method: 'POST', body })
      await fetch('/api/settings/branding', { method: 'PUT' })
      await supabase.storage.from('car-documents').createSignedUrl(p, 60)
      // await supabase.from('cars').select('*')
      /* supabase.from('company_settings').update(x) */
      await supabase.from('car_notes_archive').select('*')
      await supabase.from('cars_view').select('*')
      const [cars, setCars] = useState([])
      cars.map((car) => carTitle(car))
      const label = 'No cars yet.'
      router.push('/cars/active')`
    expect(carsClientUses(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(carsClientUses("const a = 'image/*'\nsupabase.from('cars').update(p)\nconst b = '*/'\n")).toEqual(['cars.update'])
    expect(carsClientUses("const r = /\\/*/\nsupabase.from('company_settings').delete()\nconst s = '*/'\n")).toEqual(['company_settings.delete'])
    expect(carsClientUses("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('car_documents').insert(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['car_documents.insert'])
    expect(carsClientUses("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('cars').select('*') */}\n  </div>\n}\n"))
      .toEqual([])
  })
})

describe('later migrations keep the five tables closed to clients (mig 674)', () => {
  it('mig 674 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${CLOSED_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it.each(later)('%s: no client privilege, no client role, no permissive policy, RLS kept on the five', (file) => {
    expect(carsReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens cars/car_documents/car_bca_*/company_settings to a client role (mig 674). Go through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT SELECT ON public.cars TO authenticated;',
      'grant update on table company_settings to anon, authenticated;',
      'GRANT ALL ON "public"."car_documents" TO PUBLIC;',
      'GRANT SELECT (logo_url, company_name) ON public.company_settings TO authenticated;',
      'GRANT UPDATE (storage_path) ON public.car_documents TO authenticated;',
      'GRANT MAINTAIN ON public.car_bca_submissions TO authenticated;',
      'GRANT SELECT ON public.car_bca_submission_events TO anon;',
      'GRANT REFERENCES ON public.cars TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT DELETE ON public.orders, public.cars TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.company_settings TO authenticated'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT UPDATE ON public.cars TO authenticated'; END $x$;`,
      'CREATE POLICY cars_location_scoped ON public.cars FOR ALL TO authenticated USING (private.auth_is_in_location(location_id));',
      'create policy "x" on company_settings to authenticated using (true);',
      'CREATE POLICY r ON public.company_settings FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));',
      'CREATE POLICY r ON public.car_bca_submissions FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY n ON public.car_bca_submission_events FOR INSERT TO authenticated WITH CHECK (false);',
      'ALTER TABLE public.cars DISABLE ROW LEVEL SECURITY;',
      'alter table only company_settings disable row level security;',
      'ALTER TABLE IF EXISTS ONLY public.car_documents DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.company_settings ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
      'alter table "public"."cars"\n  alter column make set not null,\n  disable row level security;',
      'ALTER TABLE public.cars OWNER TO authenticated;',
      'ALTER TABLE public.company_settings OWNER TO "anon";',
      'GRANT car_writer TO authenticated;',
      'CREATE TABLE IF NOT EXISTS public.company_settings (id uuid);',
      'CREATE TABLE public.cars (id uuid);',
      'ALTER TABLE public.cars_v2 RENAME TO cars;',
      "SELECT '/*';\nGRANT SELECT ON public.cars TO authenticated;\nSELECT '*/';",
      "-- a note with /* in it\nGRANT UPDATE ON public.company_settings TO authenticated;\n-- */",
      "COMMENT ON TABLE x IS $c$ it's -- /* $c$;\nGRANT SELECT ON public.car_documents TO authenticated;\nSELECT '*/';",
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT SELECT ON public.car_bca_submissions TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(carsReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT ALL ON public.cars TO service_role;',
      'GRANT SELECT ON public.car_notes TO service_role;',
      'GRANT SELECT ON public.cars_archive TO authenticated;',
      'GRANT UPDATE ON public.orders TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.increment_car_xero_issue_count(uuid) TO service_role;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.cars, public.car_documents, public.company_settings FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY d ON public.cars AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);',
      'CREATE POLICY p ON public.car_enquiries FOR ALL TO authenticated USING (true);',
      'CREATE POLICY p ON public.cars_archive FOR ALL TO authenticated USING (true);',
      'ALTER TABLE public.cars ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.cars ADD COLUMN vat_margin numeric(10,2);',
      'ALTER TABLE public.company_settings ADD COLUMN footer_note text;',
      'ALTER TABLE public.car_enquiries DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.cars OWNER TO postgres;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.car_enquiries (id uuid);',
      'ALTER TABLE public.cars RENAME COLUMN notes TO internal_notes;',
      'ALTER TABLE public.invoices_queue ADD COLUMN source_car_document_id uuid REFERENCES public.car_documents(id);',
      '-- rollback: GRANT SELECT ON public.cars TO authenticated;',
      '/* GRANT ALL ON public.company_settings TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT UPDATE ON public.cars TO authenticated;
       END $$;`,
    ]
    for (const sql of ok) expect(carsReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('675_carsclientwrite1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('675_cars_regrant.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('675_anymemberwrite1_rollback.sql')).toBe(false)
  })
})
